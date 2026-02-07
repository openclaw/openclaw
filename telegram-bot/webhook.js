// OpenClaw Telegram Bot с Composio MCP поддержкой
import { Bot, InlineKeyboard, webhookCallback } from "https://deno.land/x/grammy@v1.19.2/mod.ts";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
const COMPOSIO_API_KEY = Deno.env.get("COMPOSIO_API_KEY");

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const bot = new Bot(TELEGRAM_BOT_TOKEN);

// Установка команд в меню бота
bot.api.setMyCommands([
  { command: "start", description: "Запустить бота" },
  { command: "search", description: "Поиск информации через MCP" },
  { command: "news", description: "Получить последние новости" },
  { command: "help", description: "Помощь по боту" },
]);

// Команда /start
bot.command("start", async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text("🔍 Поиск", "search_button")
    .text("📰 Новости", "news_button")
    .row()
    .text("ℹ️ Помощь", "help_button")
    .text("🛠 Мои инструменты", "tools_button");

  await ctx.reply(
    "Привет! Я OpenClaw, ваш AI-ассистент. Как я могу вам помочь?",
    { reply_markup: keyboard }
  );
});

// Команда /help
bot.command("help", async (ctx) => {
  const helpText = `📖 *Помощь по боту*

*Доступные команды:*
/start - Главное меню
/search - Поиск информации
/news - Последние новости
/help - Эта справка

*Inline кнопки:*
🔍 Поиск - Найти информацию через MCP
📰 Новости - Получить новости через MCP
🛠 Мои инструменты - Показать доступные инструменты
ℹ️ Помощь - Справка

Просто напишите мне сообщение, и я помогу!`;

  await ctx.reply(helpText, { parse_mode: "Markdown" });
});

// Команда /search
bot.command("search", async (ctx) => {
  await ctx.reply("🔍 Что вы хотите найти? Просто напишите ваш запрос.");
});

// Команда /news
bot.command("news", async (ctx) => {
  await ctx.reply("📰 Получаю последние новости через MCP...");

  try {
    const result = await callComposioMCP({
      toolkit: "composio_search",
      action: "search",
      params: { query: "latest news" }
    });

    await ctx.reply(`Новости:\n\n${result || "Не удалось получить новости"}`);
  } catch (error) {
    console.error("News error:", error);
    await ctx.reply("❌ Ошибка при получении новостей. Попробуйте позже.");
  }
});

// Обработка inline кнопок
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  await ctx.answerCallbackQuery();

  switch (data) {
    case "search_button":
      await ctx.reply("🔍 Что вы хотите найти? Просто напишите ваш запрос.");
      break;

    case "news_button":
      await ctx.reply("📰 Получаю новости...");
      try {
        const result = await callComposioMCP({
          toolkit: "composio_search",
          action: "search",
          params: { query: "latest news" }
        });
        await ctx.reply(`Новости:\n\n${result || "Не удалось получить новости"}`);
      } catch (error) {
        console.error("News error:", error);
        await ctx.reply("❌ Ошибка при получении новостей");
      }
      break;

    case "help_button":
      await ctx.reply(`📖 *Помощь*\n\nДоступные команды:\n/start - Главное меню\n/search - Поиск\n/news - Новости\n/help - Справка`, {
        parse_mode: "Markdown"
      });
      break;

    case "tools_button":
      const toolsList = `🛠 *Мои инструменты:*

1. /search - поиск информации в MCP
2. /news - получение новостей через MCP

Напишите мне что-нибудь, и я постараюсь помочь!`;

      await ctx.reply(toolsList, { parse_mode: "Markdown" });
      break;
  }
});

// Обработка текстовых сообщений
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;

  // Пропускаем команды
  if (text.startsWith("/")) {
    return;
  }

  await ctx.reply("🤔 Обрабатываю ваш запрос...");

  try {
    // Используем Composio MCP для поиска
    const result = await callComposioMCP({
      toolkit: "composio_search",
      action: "search", 
      params: { query: text }
    });

    await ctx.reply(result || "Не удалось найти информацию");
  } catch (error) {
    console.error("MCP Error:", error);
    await ctx.reply("❌ Ошибка МСР: " + (error.message || "Неизвестная ошибка"));
  }
});

// Функция для вызова Composio MCP
async function callComposioMCP({ toolkit, action, params }) {
  if (!COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY not configured");
  }

  try {
    const response = await fetch("https://api.composio.dev/v2/actions/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": COMPOSIO_API_KEY,
      },
      body: JSON.stringify({
        toolkitName: toolkit,
        actionName: action,
        params: params,
      }),
    });

    if (!response.ok) {
      throw new Error(`MCP Error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    return JSON.stringify(data, null, 2);
  } catch (error) {
    console.error("Composio MCP call failed:", error);
    throw error;
  }
}

// Error handler
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  console.error("Error:", e);
});

// Webhook handler для Vercel
export default webhookCallback(bot, "std/http");
