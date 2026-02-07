const { Bot, InlineKeyboard, webhookCallback } = require("grammy");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Groq модели
const GROQ_MODELS = {
  "llama-3.3-70b-versatile": "🦙 Llama 3.3 70B (Самая умная)",
  "llama-3.1-70b-versatile": "🦙 Llama 3.1 70B (Быстрая)",
  "llama-3.1-8b-instant": "⚡ Llama 3.1 8B (Очень быстрая)",
  "mixtral-8x7b-32768": "🔀 Mixtral 8x7B",
  "gemma2-9b-it": "💎 Gemma 2 9B"
};

// Хранилище моделей пользователей
const userModels = new Map();

// Главное меню
function getMainMenu() {
  return new InlineKeyboard()
    .text("🤖 Выбрать AI модель", "select_model")
    .text("🔍 Поиск", "action_search").row()
    .text("📰 Новости", "action_news")
    .text("💻 GitHub", "action_github").row()
    .text("🌐 Web Search", "action_web")
    .text("❓ Помощь", "action_help");
}

// Меню моделей
function getModelMenu() {
  const keyboard = new InlineKeyboard();
  for (const [model, name] of Object.entries(GROQ_MODELS)) {
    keyboard.text(name, `model_${model}`).row();
  }
  keyboard.text("« Назад", "back_to_menu");
  return keyboard;
}

// Установка команд
bot.api.setMyCommands([
  { command: "start", description: "🏠 Главное меню" },
  { command: "model", description: "🤖 Выбрать AI модель" },
  { command: "search", description: "🔍 Поиск" },
  { command: "help", description: "❓ Помощь" }
]).catch(console.error);

// /start
bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  const currentModel = userModels.get(userId) || "llama-3.1-8b-instant";

  await ctx.reply(
    `🦞 *Привет! Я OpenClaw AI*\n\n` +
    `Модель: ${GROQ_MODELS[currentModel]}\n\n` +
    `Выберите действие:`,
    { reply_markup: getMainMenu(), parse_mode: "Markdown" }
  );
});

// /model
bot.command("model", async (ctx) => {
  await ctx.reply(
    "🤖 *Выберите модель:*\n\n" +
    "• 70B - самые умные\n" +
    "• 8B - очень быстрые\n" +
    "• Mixtral - баланс",
    { reply_markup: getModelMenu(), parse_mode: "Markdown" }
  );
});

// /search
bot.command("search", async (ctx) => {
  await ctx.reply("🔍 Введите поисковый запрос:");
});

// /help
bot.command("help", async (ctx) => {
  await ctx.reply(
    `📖 *Помощь*\n\n` +
    `*Команды:*\n` +
    `/start - Меню\n` +
    `/model - Модель\n` +
    `/search - Поиск\n\n` +
    `*Возможности:*\n` +
    `🤖 5 моделей Groq\n` +
    `🔍 Поиск через MCP\n` +
    `📰 Новости\n` +
    `💻 GitHub\n` +
    `🌐 Web поиск`,
    { parse_mode: "Markdown" }
  );
});

// Callback queries
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from?.id;

  await ctx.answerCallbackQuery();

  // Выбор модели
  if (data.startsWith("model_")) {
    const model = data.replace("model_", "");
    userModels.set(userId, model);

    await ctx.editMessageText(
      `✅ *Выбрана:*\n${GROQ_MODELS[model]}`,
      {
        reply_markup: new InlineKeyboard().text("« Назад", "back_to_menu"),
        parse_mode: "Markdown"
      }
    );
    return;
  }

  // Действия
  switch (data) {
    case "select_model":
      await ctx.editMessageText(
        "🤖 *Выберите модель:*",
        { reply_markup: getModelMenu(), parse_mode: "Markdown" }
      );
      break;

    case "action_search":
      await ctx.editMessageText("🔍 Введите запрос:");
      break;

    case "action_news":
      await ctx.editMessageText("📰 Получаю новости...");
      try {
        const model = userModels.get(userId) || "llama-3.1-8b-instant";
        const answer = await askGroq(model, "Расскажи последние новости в технологиях на русском");
        await ctx.editMessageText(
          `📰 *Новости:*\n\n${answer}`,
          {
            reply_markup: new InlineKeyboard().text("« Назад", "back_to_menu"),
            parse_mode: "Markdown"
          }
        );
      } catch (error) {
        await ctx.editMessageText(`❌ ${error.message}`);
      }
      break;

    case "action_github":
      const githubMenu = new InlineKeyboard()
        .text("⭐ Trending", "github_trending")
        .text("« Назад", "back_to_menu");
      await ctx.editMessageText("💻 *GitHub*", {
        reply_markup: githubMenu,
        parse_mode: "Markdown"
      });
      break;

    case "github_trending":
      await ctx.editMessageText("⭐ Ищу trending...");
      try {
        const model = userModels.get(userId) || "llama-3.1-8b-instant";
        const answer = await askGroq(model, "Назови топ 5 trending GitHub репозиториев сегодня на русском");
        await ctx.editMessageText(
          `⭐ *Trending:*\n\n${answer}`,
          {
            reply_markup: new InlineKeyboard().text("« Назад", "back_to_menu"),
            parse_mode: "Markdown"
          }
        );
      } catch (error) {
        await ctx.editMessageText(`❌ ${error.message}`);
      }
      break;

    case "action_web":
      await ctx.editMessageText("🌐 Введите запрос для web поиска:");
      break;

    case "action_help":
      await ctx.editMessageText(
        `📖 *Помощь*\n\n` +
        `Используйте кнопки для быстрого доступа!`,
        {
          reply_markup: new InlineKeyboard().text("« Назад", "back_to_menu"),
          parse_mode: "Markdown"
        }
      );
      break;

    case "back_to_menu":
      const currentModel = userModels.get(userId) || "llama-3.1-8b-instant";
      await ctx.editMessageText(
        `🦞 *OpenClaw AI*\n\n` +
        `Модель: ${GROQ_MODELS[currentModel]}`,
        { reply_markup: getMainMenu(), parse_mode: "Markdown" }
      );
      break;
  }
});

// Текстовые сообщения
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from?.id;

  if (text.startsWith("/")) return;

  const thinking = await ctx.reply("🤔 Думаю...");

  try {
    const model = userModels.get(userId) || "llama-3.1-8b-instant";
    const answer = await askGroq(model, text);

    await ctx.api.deleteMessage(ctx.chat.id, thinking.message_id);
    await ctx.reply(answer, {
      reply_markup: new InlineKeyboard().text("🏠 Меню", "back_to_menu")
    });
  } catch (error) {
    await ctx.api.deleteMessage(ctx.chat.id, thinking.message_id);
    await ctx.reply(`❌ ${error.message}`);
  }
});

// Groq API
async function askGroq(model, prompt) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: "Ты helpful AI assistant. Отвечай на русском." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    throw new Error(`Groq API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || "Нет ответа";
}

// Error handler
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Webhook для Vercel
module.exports = webhookCallback(bot, "std/http");
