import * as cheerio from "cheerio";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.60 Safari/537.36";

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j;
}

async function fetchDescription(bookUrl) {
  try {
    const resp = await fetch(bookUrl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(resp.status);
    const $ = cheerio.load(await resp.text());
    for (const sel of [
      "div.BookPageMetadataSection__description",
      "div.description",
      "div#description span",
    ]) {
      const el = $(sel).first();
      if (el.length) {
        const text = el.text().replace(/\s+/g, " ").trim();
        return text.length > 800 ? text.slice(0, 800) + "..." : text;
      }
    }
    return "No description available.";
  } catch (e) {
    console.warn("Failed to fetch description:", e.message);
    return "Could not load description.";
  }
}

async function searchGoodreads(query, limit = 5) {
  const url = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const $ = cheerio.load(await resp.text());
    const results = [];
    $("a.bookTitle")
      .slice(0, limit)
      .each((_, el) => {
        const a = $(el);
        const href = a.attr("href") || "";
        if (!href.startsWith("/book/show")) return;
        const author =
          a.closest("tr").find("a.authorName").first().text().trim() || "Unknown";
        results.push({
          title: a.text().trim(),
          author,
          url: "https://www.goodreads.com" + href,
        });
      });
    console.log(`Found ${results.length} Goodreads results for '${query}'`);
    return results;
  } catch (e) {
    console.error("Search request failed:", e.message);
    return [];
  }
}

function bookText(book, desc) {
  return (
    `✅ *Found on Goodreads!*\n\n` +
    `📘 [${book.title}](${book.url})\n` +
    `✍️ _${book.author}_\n\n` +
    `📖 *Description:*\n_${desc}_`
  );
}

async function handleStart(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    parse_mode: "Markdown",
    text:
      "📚 *Welcome to the Goodreads Book Finder Bot!*\n\n" +
      "Use `/book <title>` to search.\n" +
      "If multiple books match, you'll get options to choose from.",
  });
}

async function handleBook(chatId, query) {
  if (!query) {
    await tg("sendMessage", { chat_id: chatId, text: "Usage: /book <book title>" });
    return;
  }
  await tg("sendMessage", {
    chat_id: chatId,
    parse_mode: "Markdown",
    text: `🔍 Searching Goodreads for *${query}*…`,
  });

  const results = await searchGoodreads(query, 5);
  if (!results.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "❌ No books found. Try a different title or check spelling.",
    });
    return;
  }

  if (results.length === 1) {
    const desc = await fetchDescription(results[0].url);
    await tg("sendMessage", {
      chat_id: chatId,
      parse_mode: "Markdown",
      text: bookText(results[0], desc),
    });
    return;
  }

  const keyboard = results.map((b) => {
    const id = b.url.split("/book/show/")[1].split(/[.\-?]/)[0];
    return [{ text: `${b.title} — ${b.author}`.slice(0, 100), callback_data: `b:${id}` }];
  });
  await tg("sendMessage", {
    chat_id: chatId,
    text: "📚 Multiple results found — please choose one:",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleCallback(cb) {
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;

  const id = (cb.data || "").replace(/^b:/, "");
  const buttons = (cb.message.reply_markup?.inline_keyboard || []).flat();
  const btn = buttons.find((b) => b.callback_data === cb.data);
  if (!id || !btn) {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "⚠️ Invalid selection.",
    });
    return;
  }

  const [title, ...rest] = btn.text.split(" — ");
  const book = {
    title,
    author: rest.join(" — ") || "Unknown",
    url: `https://www.goodreads.com/book/show/${id}`,
  };
  const desc = await fetchDescription(book.url);
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "Markdown",
    text: bookText(book, desc),
  });
}

async function reportError(chatId, e) {
  console.error("Handler error:", e);
  if (!chatId) return;
  try {
    await tg("sendMessage", { chat_id: chatId, text: "Error: " + e.message });
  } catch (_) {}
}

export default async (req) => {
  if (req.method !== "POST") return new Response("ok");
  let chatId = null;
  try {
    const update = await req.json();
    if (update.callback_query) {
      chatId = update.callback_query.message?.chat?.id;
      await handleCallback(update.callback_query);
    } else if (update.message?.text) {
      chatId = update.message.chat.id;
      const text = update.message.text.trim();
      const m = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
      if (m) {
        const cmd = m[1].toLowerCase();
        if (cmd === "start") await handleStart(chatId);
        else if (cmd === "book") await handleBook(chatId, m[2].trim());
      }
    }
  } catch (e) {
    await reportError(chatId, e);
  }
  return new Response("ok", { status: 200 });
};
