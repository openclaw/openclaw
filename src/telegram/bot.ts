// @ts-nocheck
import { Buffer } from "node:buffer";

import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions, Message } from "grammy";
import { Bot, InlineKeyboard, InputFile, webhookCallback } from "grammy";

import { chunkText, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ReplyToMode } from "../config/config.js";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  resolveSessionKey,
  saveSessionStore,
  updateLastRoute,
} from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { mediaKindFromMime } from "../media/constants.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadWebMedia } from "../web/media.js";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { writeOAuthCredentials } from "../commands/onboard-auth.js";
import { resolveTelegramSystemCommand } from "./system-commands.js";

// Store pending reauth verifiers by chat ID
const pendingReauths = new Map<number, { verifier: string; timestamp: number }>();

const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity/i;

type TelegramMessage = Message.CommonMessage;

type TelegramContext = {
  message: TelegramMessage;
  me?: { username?: string };
  getFile: () => Promise<{
    file_path?: string;
  }>;
};

export type TelegramBotOptions = {
  token: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  replyToMode?: ReplyToMode;
  proxyFetch?: typeof fetch;
};

export function createTelegramBot(opts: TelegramBotOptions) {
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const client: ApiClientOptions | undefined = opts.proxyFetch
    ? { fetch: opts.proxyFetch as unknown as ApiClientOptions["fetch"] }
    : undefined;

  const bot = new Bot(opts.token, { client });
  bot.api.config.use(apiThrottler());

  const cfg = loadConfig();
  const textLimit = resolveTextChunkLimit(cfg, "telegram");
  const allowFrom = opts.allowFrom ?? cfg.telegram?.allowFrom;
  const replyToMode = opts.replyToMode ?? cfg.telegram?.replyToMode ?? "off";
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.telegram?.mediaMaxMb ?? 5) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const resolveGroupRequireMention = (chatId: string | number) => {
    const groupId = String(chatId);
    const groupConfig = cfg.telegram?.groups?.[groupId];
    if (typeof groupConfig?.requireMention === "boolean") {
      return groupConfig.requireMention;
    }
    const groupDefault = cfg.telegram?.groups?.["*"]?.requireMention;
    if (typeof groupDefault === "boolean") return groupDefault;
    if (typeof opts.requireMention === "boolean") return opts.requireMention;
    return true;
  };

  /** Resolve skills filter based on group/topic config */
  const resolveGroupSkills = (
    chatId: string | number,
    topicId?: number,
  ): string[] | undefined => {
    const groupId = String(chatId);
    const groupConfig = cfg.telegram?.groups?.[groupId];
    if (!groupConfig) return undefined;

    // If there's a topic ID and topic config exists, use topic skills
    if (topicId !== undefined) {
      const topicConfig = groupConfig.topics?.[String(topicId)];
      if (topicConfig?.skills?.length) {
        return topicConfig.skills;
      }
    }

    // Fall back to group-level skills
    if (groupConfig.skills?.length) {
      return groupConfig.skills;
    }

    return undefined;
  };

  // Get model aliases from config
  const modelAliases = cfg.agent?.modelAliases ?? {};
  const allowedModels = cfg.agent?.allowedModels ?? [];

  // Build model keyboard from config
  const buildModelKeyboard = () => {
    const keyboard = new InlineKeyboard();
    // Add aliases as buttons (they're user-friendly names)
    const aliases = Object.keys(modelAliases);
    if (aliases.length > 0) {
      for (let i = 0; i < aliases.length; i++) {
        keyboard.text(aliases[i], `model:${aliases[i]}`);
        if ((i + 1) % 3 === 0) keyboard.row(); // 3 buttons per row
      }
    } else {
      // Fall back to allowed models
      for (let i = 0; i < Math.min(allowedModels.length, 6); i++) {
        const model = allowedModels[i];
        const shortName = model.split("/").pop() || model;
        keyboard.text(shortName, `model:${model}`);
        if ((i + 1) % 2 === 0) keyboard.row();
      }
    }
    return keyboard;
  };

  // Handle callback queries (button presses)
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const callbackMessage = ctx.callbackQuery.message;
    const chat = callbackMessage?.chat;
    const chatId = chat?.id;
    if (!chatId) return;

    const isGroup = chat.type === "group" || chat.type === "supergroup";
    const topicId = (callbackMessage as { message_thread_id?: number })
      ?.message_thread_id;
    const sessionCfg = cfg.session;
    const sessionKey = resolveSessionKey(
      sessionCfg?.scope ?? "per-sender",
      {
        From: isGroup ? `group:${chatId}` : `telegram:${chatId}`,
        ChatType: isGroup ? "group" : "direct",
        Surface: "telegram",
      },
      sessionCfg?.mainKey,
    );
    const storePath = resolveStorePath(sessionCfg?.store);
    const senderName = buildSenderName({
      from: ctx.callbackQuery.from,
    } as TelegramMessage);
    const ctxPayloadBase = {
      From: isGroup ? `group:${chatId}` : `telegram:${chatId}`,
      To: `telegram:${chatId}`,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? (chat.title ?? undefined) : undefined,
      SenderName: senderName ?? undefined,
      Surface: "telegram",
      MessageSid: String(callbackMessage?.message_id ?? ctx.callbackQuery.id),
      Timestamp: callbackMessage?.date ? callbackMessage.date * 1000 : undefined,
    };
    const skillFilter = isGroup
      ? resolveGroupSkills(chatId, topicId)
      : undefined;
    const sendTyping = async () => {
      try {
        await bot.api.sendChatAction(chatId, "typing", {
          message_thread_id: topicId,
        });
      } catch {
        // ignore typing errors
      }
    };

    try {
      if (data.startsWith("model:")) {
        const modelChoice = data.replace("model:", "");
        // Send the model switch command as a message to be processed
        const body = `/model ${modelChoice}`;
        const ctxPayload = {
          ...ctxPayloadBase,
          Body: body,
        };
        await ctx.answerCallbackQuery({ text: `Switching to ${modelChoice}...` });
        // Process through the normal reply flow
        await getReplyFromConfig(
          ctxPayload,
          { onReplyStart: sendTyping, skillFilter },
          cfg,
        );
        await ctx.editMessageText(`✅ Model switched to ${modelChoice}`);
      } else if (data.startsWith("think:")) {
        const level = data.replace("think:", "");
        const store = loadSessionStore(storePath);
        const entry = store[sessionKey];
        if (entry) {
          entry.thinkingLevel = level === "off" ? undefined : level;
          entry.updatedAt = Date.now();
          await saveSessionStore(storePath, store);
        }
        await ctx.answerCallbackQuery({ text: `Thinking: ${level}` });
        await ctx.editMessageText(`✅ Thinking level set to ${level}`);
      } else if (data.startsWith("verbose:")) {
        const level = data.replace("verbose:", "") as "on" | "off";
        const store = loadSessionStore(storePath);
        const entry = store[sessionKey];
        if (entry) {
          entry.verboseLevel = level;
          entry.updatedAt = Date.now();
          await saveSessionStore(storePath, store);
        }
        const emoji = level === "on" ? "🔊" : "🔇";
        await ctx.answerCallbackQuery({ text: `Verbose: ${level}` });
        await ctx.editMessageText(`${emoji} Verbose mode set to ${level}`);
      } else if (data.startsWith("elevated:")) {
        const level = data.replace("elevated:", "") as "on" | "off";
        const store = loadSessionStore(storePath);
        const entry = store[sessionKey];
        if (entry) {
          entry.elevatedLevel = level;
          entry.updatedAt = Date.now();
          await saveSessionStore(storePath, store);
        }
        const emoji = level === "on" ? "⚡" : "🔒";
        await ctx.answerCallbackQuery({ text: `Elevated: ${level}` });
        await ctx.editMessageText(`${emoji} Elevated permissions set to ${level}`);
      } else if (data.startsWith("ai:")) {
        // AI-generated button clicked - send button text as user message to AI
        const buttonText = data.slice(3); // Remove "ai:" prefix
        await ctx.answerCallbackQuery({ text: "Processing..." });

        // Update the original message to show what was selected
        const originalText = ctx.callbackQuery.message?.text || "";
        try {
          await ctx.editMessageText(`${originalText}\n\n✅ Selected: ${buttonText}`);
        } catch {
          // Ignore edit errors (message might be too old)
        }

        // Send the button text as a new message to the AI
        const ctxPayload = {
          ...ctxPayloadBase,
          Body: buttonText,
        };

        // Process through normal AI flow
        const replyResult = await getReplyFromConfig(
          ctxPayload,
          { onReplyStart: sendTyping, skillFilter },
          cfg,
        );
        const replies = replyResult
          ? Array.isArray(replyResult)
            ? replyResult
            : [replyResult]
          : [];

        if (replies.length > 0) {
          await deliverReplies({
            replies,
            chatId: String(chatId),
            token: opts.token,
            runtime,
            bot,
            replyToMode,
            textLimit,
            topicId,
          });
        }
      }
    } catch (err) {
      logger.error({ err }, "callback query failed");
      await ctx.answerCallbackQuery({ text: "Error processing selection" });
    }
  });

  // System commands that respond instantly (no AI)
  const handleSystemCommand = async (
    text: string,
    chatId: number,
    botUsername?: string,
    topicId?: number,
    isGroup?: boolean,
  ): Promise<boolean> => {
    let cmdRaw = text.trim().toLowerCase().split(/\s+/)[0];
    // Strip @botusername suffix (e.g., /model@yourbot -> /model)
    if (botUsername && cmdRaw.includes("@")) {
      cmdRaw = cmdRaw.split("@")[0];
    }
    const cmd = cmdRaw.startsWith("/") ? cmdRaw.slice(1) : cmdRaw;
    const args = text.trim().slice(text.trim().split(/\s+/)[0].length).trim();
    const command = resolveTelegramSystemCommand(cmd);
    if (!command) return false;
    const sendSystemTyping = async () => {
      try {
        await bot.api.sendChatAction(chatId, "typing", {
          message_thread_id: topicId,
        });
      } catch {
        // Ignore typing errors for system commands
      }
    };
    const resolveSessionKeyForChat = () => {
      const sessionCfg = cfg.session;
      return resolveSessionKey(
        sessionCfg?.scope ?? "per-sender",
        {
          From: isGroup ? `group:${chatId}` : `telegram:${chatId}`,
          ChatType: isGroup ? "group" : "direct",
          Surface: "telegram",
        },
        sessionCfg?.mainKey,
      );
    };

    // /model - show model selection buttons
    if (command.id === "model") {
      if (args && cmd === "model") {
        // User specified a model, let it go through to AI
        return false;
      }
      const keyboard = buildModelKeyboard();
      const currentModel = cfg.agent?.model || "claude-opus-4-5";
      await sendSystemTyping();
      await bot.api.sendMessage(
        chatId,
        `🤖 *Current model:* \`${currentModel}\`\n\nSelect a model:`,
        { reply_markup: keyboard, parse_mode: "Markdown", message_thread_id: topicId },
      );
      return true;
    }

    // /think - show thinking level buttons
    if (command.id === "think") {
      if (args) return false; // Let specific level go to AI
      const keyboard = new InlineKeyboard()
        .text("Off", "think:off")
        .text("Low", "think:low")
        .text("Medium", "think:medium")
        .text("High", "think:high");
      await sendSystemTyping();
      await bot.api.sendMessage(chatId, "🧠 Select thinking level:", {
        reply_markup: keyboard,
        message_thread_id: topicId,
      });
      return true;
    }

    // /status - show status (instant)
    if (command.id === "status") {
      const model = cfg.agent?.model || "unknown";
      const workspace = cfg.agent?.workspace || "~/.clawdis";
      const sessionKey = resolveSessionKeyForChat();
      const storePath = resolveStorePath(cfg.session?.store);
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      const elevated =
        entry?.elevatedLevel ?? cfg.agent?.elevatedDefault ?? "on";
      await sendSystemTyping();
      await bot.api.sendMessage(
        chatId,
        `📊 *Status*\n\n• Model: \`${model}\`\n• Workspace: \`${workspace}\`\n• Elevated: \`${elevated}\`\n• Telegram: ✅ Connected`,
        { parse_mode: "Markdown", message_thread_id: topicId },
      );
      return true;
    }

    // /new or /reset - reset chat session (instant)
    if (command.id === "new") {
      try {
        const sessionKey = resolveSessionKeyForChat();
        const storePath = resolveStorePath(cfg.session?.store);
        const store = loadSessionStore(storePath);
        const entry = store[sessionKey];
        const now = Date.now();
        const next: SessionEntry = {
          sessionId: randomUUID(),
          updatedAt: now,
          systemSent: false,
          abortedLastRun: false,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          model: entry?.model,
          contextTokens: entry?.contextTokens,
          sendPolicy: entry?.sendPolicy,
          lastChannel: "telegram",
          lastTo: String(chatId),
          skillsSnapshot: entry?.skillsSnapshot,
        };
        store[sessionKey] = next;
        await saveSessionStore(storePath, store);
        await sendSystemTyping();
        await bot.api.sendMessage(chatId, "✨ Chat session reset. Starting fresh!", {
          message_thread_id: topicId,
        });
      } catch (err) {
        logger.error({ err }, "session reset failed");
        await sendSystemTyping();
        await bot.api.sendMessage(chatId, "❌ Failed to reset session", {
          message_thread_id: topicId,
        });
      }
      return true;
    }

    // /verbose - show verbose mode buttons (instant)
    if (command.id === "verbose") {
      const sessionKey = resolveSessionKeyForChat();
      const storePath = resolveStorePath(cfg.session?.store);
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      const currentLevel = entry?.verboseLevel || "off";
      const keyboard = new InlineKeyboard()
        .text("🔇 Off", "verbose:off")
        .text("🔊 On", "verbose:on");
      await sendSystemTyping();
      await bot.api.sendMessage(
        chatId,
        `🔊 *Verbose mode:* \`${currentLevel}\`\n\nWhen on, the agent shows more detailed reasoning.`,
        { reply_markup: keyboard, parse_mode: "Markdown", message_thread_id: topicId },
      );
      return true;
    }

    // /topicid - show current chat and topic IDs (instant)
    if (command.id === "id") {
      const info = [
        `📍 *Chat Info*`,
        ``,
        `Chat ID: \`${chatId}\``,
        topicId ? `Topic ID: \`${topicId}\`` : `Topic: General (no topic ID)`,
      ].join("\n");
      await sendSystemTyping();
      await bot.api.sendMessage(chatId, info, {
        parse_mode: "Markdown",
        message_thread_id: topicId,
      });
      return true;
    }

    // /restart - restart the gateway (instant)
    if (command.id === "restart") {
      await sendSystemTyping();
      await bot.api.sendMessage(chatId, "🔄 Restarting gateway...", {
        message_thread_id: topicId,
      });
      // Exit after a short delay to allow message to send
      setTimeout(() => {
        process.exit(0);
      }, 500);
      return true;
    }

    // /reauth - start OAuth re-authentication flow
    if (command.id === "reauth") {
      try {
        // Generate PKCE values
        const { createHash, randomBytes } = await import("node:crypto");
        const verifierBytes = randomBytes(32);
        const verifier = verifierBytes.toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");

        // Build OAuth URL (same as pi-ai anthropic.js)
        const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
        const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
        const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
        const SCOPES = "org:create_api_key user:profile user:inference";

        const authParams = new URLSearchParams({
          code: "true",
          client_id: CLIENT_ID,
          response_type: "code",
          redirect_uri: REDIRECT_URI,
          scope: SCOPES,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: verifier,
        });
        const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

        // Store verifier for this chat
        pendingReauths.set(chatId, { verifier, timestamp: Date.now() });

        // Send the URL as a clickable button to avoid URL mangling
        const keyboard = new InlineKeyboard().url("🔑 Open OAuth Login", authUrl);
        await sendSystemTyping();
        await bot.api.sendMessage(
          chatId,
          `🔑 *Anthropic OAuth Re-authentication*\n\n` +
          `1. Click the button below\n` +
          `2. Sign in with your Anthropic account\n` +
          `3. Copy the code shown (format: \`code#state\`)\n` +
          `4. Paste it here in this chat\n\n` +
          `_Link expires in 10 minutes_`,
          { parse_mode: "Markdown", message_thread_id: topicId, reply_markup: keyboard },
        );
      } catch (err) {
        await sendSystemTyping();
        await bot.api.sendMessage(
          chatId,
          `❌ Failed to generate OAuth URL: ${String(err)}`,
          { message_thread_id: topicId },
        );
      }
      return true;
    }

    // /retry - retry all cron jobs (instant)
    if (command.id === "retry") {
      await sendSystemTyping();
      await bot.api.sendMessage(
        chatId,
        "🔄 Retrying cron jobs in 3 seconds...",
        { message_thread_id: topicId },
      );
      // Trigger cron jobs after a short delay
      // Note: Configure CLAWDBOT_RETRY_CRON_IDS env var with comma-separated cron IDs
      setTimeout(async () => {
        const { exec } = await import("node:child_process");
        const cronIds = process.env.CLAWDBOT_RETRY_CRON_IDS?.split(",").filter(Boolean) ?? [];
        const sourceDir = process.env.CLAWDBOT_SOURCE_DIR ?? process.cwd();
        if (cronIds.length === 0) {
          logger.warn("No cron IDs configured for /retry command (set CLAWDBOT_RETRY_CRON_IDS)");
          return;
        }
        const cmds = cronIds.map(id => `node dist/index.js cron run ${id.trim()} --force`).join(" & ");
        exec(`cd ${sourceDir} && ${cmds}`);
      }, 3000);
      return true;
    }

    // /elevated - show elevated permissions buttons (instant)
    if (command.id === "elevated") {
      const sessionKey = resolveSessionKeyForChat();
      const storePath = resolveStorePath(cfg.session?.store);
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      const currentLevel = entry?.elevatedLevel || "off";
      const keyboard = new InlineKeyboard()
        .text("🔒 Off", "elevated:off")
        .text("⚡ On", "elevated:on");
      await sendSystemTyping();
      await bot.api.sendMessage(
        chatId,
        `⚡ *Elevated permissions:* \`${currentLevel}\`\n\nWhen on, allows sudo/admin bash commands.`,
        { reply_markup: keyboard, parse_mode: "Markdown", message_thread_id: topicId },
      );
      return true;
    }

    return false; // Not a system command, continue to AI
  };

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) return;
      const chatId = msg.chat.id;
      const isGroup =
        msg.chat.type === "group" || msg.chat.type === "supergroup";

      // Extract topic ID for forum groups (message_thread_id) - MUST be early for system commands
      const topicId = (msg as { message_thread_id?: number }).message_thread_id;

      // Debug: Log topic ID for all messages
      if (isGroup) {
        logger.info(
          { chatId, topicId, isGroup, chatType: msg.chat.type },
          `Telegram message received - chatId=${chatId} topicId=${topicId ?? "undefined (general)"}`,
        );
      }

      // Check for system commands first (instant response, no AI)
      const msgText = msg.text ?? msg.caption ?? "";
      const botUsername = ctx.me?.username?.toLowerCase();
      if (msgText.startsWith("/")) {
        const handled = await handleSystemCommand(
          msgText,
          chatId,
          botUsername,
          topicId,
          isGroup,
        );
        if (handled) return;
      }

      // Check for OAuth code#state response (from /reauth flow)
      const pendingReauth = pendingReauths.get(chatId);
      if (pendingReauth && msgText.includes("#") && !msgText.startsWith("/")) {
        const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
        if (pendingReauth.timestamp > tenMinutesAgo) {
          // Looks like an OAuth code - try to process it
          const [code, state] = msgText.trim().split("#");
          if (code && state) {
            try {
              await bot.api.sendMessage(chatId, "🔄 Processing OAuth code...", {
                message_thread_id: topicId,
              });

              // Exchange code for tokens
              const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
              const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
              const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

              const tokenResponse = await fetch(TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  grant_type: "authorization_code",
                  client_id: CLIENT_ID,
                  code: code,
                  state: state,
                  redirect_uri: REDIRECT_URI,
                  code_verifier: pendingReauth.verifier,
                }),
              });

              if (!tokenResponse.ok) {
                const error = await tokenResponse.text();
                throw new Error(`Token exchange failed: ${error}`);
              }

              const tokenData = await tokenResponse.json() as {
                access_token: string;
                refresh_token: string;
                expires_in: number;
              };

              // Save credentials
              const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;
              await writeOAuthCredentials("anthropic", {
                refresh: tokenData.refresh_token,
                access: tokenData.access_token,
                expires: expiresAt,
              });

              // Clear pending reauth
              pendingReauths.delete(chatId);

              await bot.api.sendMessage(
                chatId,
                "✅ OAuth tokens saved successfully!\n\nYou can now use /retry to re-run failed operations.",
                { message_thread_id: topicId },
              );
              return;
            } catch (err) {
              await bot.api.sendMessage(
                chatId,
                `❌ OAuth token exchange failed: ${String(err)}`,
                { message_thread_id: topicId },
              );
              return;
            }
          }
        } else {
          // Expired - clear it
          pendingReauths.delete(chatId);
        }
      }

      const sendTyping = async () => {
        try {
          await bot.api.sendChatAction(chatId, "typing", {
            message_thread_id: topicId,
          });
        } catch (err) {
          logVerbose(
            `telegram typing cue failed for chat ${chatId}: ${String(err)}`,
          );
        }
      };

      // Security: Only respond in explicitly configured groups
      if (isGroup) {
        const groupId = String(chatId);
        const groupTitle = msg.chat.title ?? "unknown";
        const configuredGroups = cfg.telegram?.groups;
        // If groups config exists, only allow configured groups (no "*" wildcard)
        if (configuredGroups && !configuredGroups[groupId]) {
          logger.warn(
            { groupId, groupTitle, topicId },
            `Blocked unauthorized telegram group "${groupTitle}" (id: ${groupId}${topicId ? `, topic: ${topicId}` : ""}) - add to telegram.groups config to allow`,
          );
          return;
        }
        // If no groups config at all, block all groups for security
        if (!configuredGroups) {
          logger.warn(
            { groupId, groupTitle, topicId },
            `Blocked telegram group "${groupTitle}" (id: ${groupId}${topicId ? `, topic: ${topicId}` : ""}) - no groups configured`,
          );
          return;
        }
        // Log topic ID for debugging when configuring per-topic skills
        if (topicId !== undefined) {
          logger.debug(
            { groupId, groupTitle, topicId },
            `Message from topic ${topicId} in group "${groupTitle}"`,
          );
        }
      }

      // allowFrom for direct chats
      if (!isGroup && Array.isArray(allowFrom) && allowFrom.length > 0) {
        const candidate = String(chatId);
        const allowed = allowFrom.map(String);
        const allowedWithPrefix = allowFrom.map((v) => `telegram:${String(v)}`);
        const permitted =
          allowed.includes(candidate) ||
          allowedWithPrefix.includes(`telegram:${candidate}`) ||
          allowed.includes("*");
        if (!permitted) {
          logVerbose(
            `Blocked unauthorized telegram sender ${candidate} (not in allowFrom)`,
          );
          return;
        }
      }

      const botUsername = ctx.me?.username?.toLowerCase();
      const allowFromList = Array.isArray(allowFrom)
        ? allowFrom.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
      const senderId = msg.from?.id ? String(msg.from.id) : "";
      const senderUsername = msg.from?.username ?? "";
      const commandAuthorized =
        allowFromList.length === 0 ||
        allowFromList.includes("*") ||
        (senderId && allowFromList.includes(senderId)) ||
        (senderId && allowFromList.includes(`telegram:${senderId}`)) ||
        (senderUsername &&
          allowFromList.some(
            (entry) =>
              entry.toLowerCase() === senderUsername.toLowerCase() ||
              entry.toLowerCase() === `@${senderUsername.toLowerCase()}`,
          ));
      const wasMentioned =
        Boolean(botUsername) && hasBotMention(msg, botUsername);
      const hasAnyMention = (msg.entities ?? msg.caption_entities ?? []).some(
        (ent) => ent.type === "mention",
      );
      const shouldBypassMention =
        isGroup &&
        resolveGroupRequireMention(chatId) &&
        !wasMentioned &&
        !hasAnyMention &&
        commandAuthorized &&
        hasControlCommand(msg.text ?? msg.caption ?? "");
      if (isGroup && resolveGroupRequireMention(chatId) && botUsername) {
        if (!wasMentioned && !shouldBypassMention) {
          logger.info(
            { chatId, reason: "no-mention" },
            "skipping group message",
          );
          return;
        }
      }

      const media = await resolveMedia(
        ctx,
        mediaMaxBytes,
        opts.token,
        opts.proxyFetch,
      );
      const replyTarget = describeReplyTarget(msg);
      const rawBody = (
        msg.text ??
        msg.caption ??
        media?.placeholder ??
        ""
      ).trim();
      if (!rawBody) return;
      const replySuffix = replyTarget
        ? `\n\n[Replying to ${replyTarget.sender}${
            replyTarget.id ? ` id:${replyTarget.id}` : ""
          }]\n${replyTarget.body}\n[/Replying]`
        : "";
      const body = formatAgentEnvelope({
        surface: "Telegram",
        from: isGroup
          ? buildGroupLabel(msg, chatId)
          : buildSenderLabel(msg, chatId),
        timestamp: msg.date ? msg.date * 1000 : undefined,
        body: `${rawBody}${replySuffix}`,
      });

      const ctxPayload = {
        Body: body,
        From: isGroup ? `group:${chatId}` : `telegram:${chatId}`,
        To: `telegram:${chatId}`,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
        SenderName: buildSenderName(msg),
        SenderId: senderId || undefined,
        SenderUsername: senderUsername || undefined,
        Surface: "telegram",
        MessageSid: String(msg.message_id),
        ReplyToId: replyTarget?.id,
        ReplyToBody: replyTarget?.body,
        ReplyToSender: replyTarget?.sender,
        Timestamp: msg.date ? msg.date * 1000 : undefined,
        WasMentioned: isGroup && botUsername ? wasMentioned : undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        CommandAuthorized: commandAuthorized,
      };

      if (replyTarget && shouldLogVerbose()) {
        const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
        logVerbose(
          `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
        );
      }

      if (!isGroup) {
        const sessionCfg = cfg.session;
        const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
        const storePath = resolveStorePath(sessionCfg?.store);
        await updateLastRoute({
          storePath,
          sessionKey: mainKey,
          channel: "telegram",
          to: String(chatId),
        });
      }

      if (shouldLogVerbose()) {
        const preview = body.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
        );
      }

      let blockSendChain: Promise<void> = Promise.resolve();
      const sendBlockReply = (payload: ReplyPayload) => {
        if (
          !payload?.text &&
          !payload?.mediaUrl &&
          !(payload?.mediaUrls?.length ?? 0)
        ) {
          return;
        }
        blockSendChain = blockSendChain
          .then(async () => {
            await deliverReplies({
              replies: [payload],
              chatId: String(chatId),
              token: opts.token,
              runtime,
              bot,
              replyToMode,
              textLimit,
              topicId,
            });
          })
          .catch((err) => {
            runtime.error?.(
              danger(`telegram block reply failed: ${String(err)}`),
            );
          });
      };

      // Show typing indicator when the bot will actually respond:
      // - Always in DMs
      // - In groups when mentioned
      // - In groups where requireMention is false (auto-respond)
      const groupRequiresMention = resolveGroupRequireMention(chatId);
      const shouldShowTyping = !isGroup || wasMentioned || !groupRequiresMention;

      // Resolve skills filter based on group/topic config
      const skillFilter = isGroup
        ? resolveGroupSkills(chatId, topicId)
        : undefined;

      const replyResult = await getReplyFromConfig(
        ctxPayload,
        {
          onReplyStart: shouldShowTyping ? sendTyping : undefined,
          onBlockReply: sendBlockReply,
          skillFilter,
        },
        cfg,
      );
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      await blockSendChain;
      if (replies.length === 0) return;

      await deliverReplies({
        replies,
        chatId: String(chatId),
        token: opts.token,
        runtime,
        bot,
        replyToMode,
        textLimit,
        topicId,
      });
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });

  return bot;
}

export function createTelegramWebhookCallback(
  bot: Bot,
  path = "/telegram-webhook",
) {
  return { path, handler: webhookCallback(bot, "http") };
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  chatId: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  replyToMode: ReplyToMode;
  textLimit: number;
  topicId?: number;
}) {
  const { replies, chatId, runtime, bot, replyToMode, textLimit, topicId } = params;
  // Debug: Log what topicId we're sending replies to
  logVerbose(
    `deliverReplies: chatId=${chatId} topicId=${topicId ?? "undefined"} replies=${replies.length}`,
  );
  let hasReplied = false;
  for (const reply of replies) {
    const textRaw = reply?.text?.trim() ?? "";
    // Filter out silent reply token (NO_REPLY) - don't send it as a message
    const text = textRaw && textRaw !== SILENT_REPLY_TOKEN ? textRaw : undefined;
    const hasMedia = !!reply?.mediaUrl || (reply?.mediaUrls?.length ?? 0) > 0;
    if (!text && !hasMedia) {
      continue;
    }
    const replyToId =
      replyToMode === "off"
        ? undefined
        : resolveTelegramReplyId(reply.replyToId);
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];
    if (mediaList.length === 0) {
      for (const chunk of chunkText(text || "", textLimit)) {
        await sendTelegramText(bot, chatId, chunk, runtime, {
          replyToMessageId:
            replyToId && (replyToMode === "all" || !hasReplied)
              ? replyToId
              : undefined,
          topicId,
        });
        if (replyToId && !hasReplied) {
          hasReplied = true;
        }
      }
      continue;
    }
    // media with optional caption on first item
    let first = true;
    for (const mediaUrl of mediaList) {
      const media = await loadWebMedia(mediaUrl);
      const kind = mediaKindFromMime(media.contentType ?? undefined);
      const file = new InputFile(media.buffer, media.fileName ?? "file");
      const caption = first ? text : undefined;
      first = false;
      const replyToMessageId =
        replyToId && (replyToMode === "all" || !hasReplied)
          ? replyToId
          : undefined;
      if (kind === "image") {
        await bot.api.sendPhoto(chatId, file, {
          caption,
          reply_to_message_id: replyToMessageId,
          message_thread_id: topicId,
        });
      } else if (kind === "video") {
        await bot.api.sendVideo(chatId, file, {
          caption,
          reply_to_message_id: replyToMessageId,
          message_thread_id: topicId,
        });
      } else if (kind === "audio") {
        await bot.api.sendAudio(chatId, file, {
          caption,
          reply_to_message_id: replyToMessageId,
          message_thread_id: topicId,
        });
      } else {
        await bot.api.sendDocument(chatId, file, {
          caption,
          reply_to_message_id: replyToMessageId,
          message_thread_id: topicId,
        });
      }
      if (replyToId && !hasReplied) {
        hasReplied = true;
      }
    }
  }
}

function buildSenderName(msg: TelegramMessage) {
  const name =
    [msg.from?.first_name, msg.from?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || msg.from?.username;
  return name || undefined;
}

function buildSenderLabel(msg: TelegramMessage, chatId: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const idPart = `id:${chatId}`;
  return label ? `${label} ${idPart}` : idPart;
}

function buildGroupLabel(msg: TelegramMessage, chatId: number | string) {
  const title = msg.chat?.title;
  if (title) return `${title} id:${chatId}`;
  return `group:${chatId}`;
}

function hasBotMention(msg: TelegramMessage, botUsername: string) {
  const text = (msg.text ?? msg.caption ?? "").toLowerCase();
  if (text.includes(`@${botUsername}`)) return true;
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const ent of entities) {
    if (ent.type !== "mention") continue;
    const slice = (msg.text ?? msg.caption ?? "").slice(
      ent.offset,
      ent.offset + ent.length,
    );
    if (slice.toLowerCase() === `@${botUsername}`) return true;
  }
  return false;
}

function resolveTelegramReplyId(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

async function resolveMedia(
  ctx: TelegramContext,
  maxBytes: number,
  token: string,
  proxyFetch?: typeof fetch,
): Promise<{ path: string; contentType?: string; placeholder: string } | null> {
  const msg = ctx.message;
  const m =
    msg.photo?.[msg.photo.length - 1] ??
    msg.video ??
    msg.document ??
    msg.audio ??
    msg.voice;
  if (!m?.file_id) return null;
  const file = await ctx.getFile();
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const fetchImpl = proxyFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available; set telegram.proxy in config");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download telegram file: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const data = Buffer.from(await res.arrayBuffer());
  const mime = await detectMime({
    buffer: data,
    headerMime: res.headers.get("content-type"),
    filePath: file.file_path,
  });
  const saved = await saveMediaBuffer(data, mime, "inbound", maxBytes);
  let placeholder = "<media:document>";
  if (msg.photo) placeholder = "<media:image>";
  else if (msg.video) placeholder = "<media:video>";
  else if (msg.audio || msg.voice) placeholder = "<media:audio>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}

// Parse BTN: lines from text and return buttons + cleaned text
function parseButtons(text: string): { cleanText: string; buttons: string[] } {
  const lines = text.split("\n");
  const buttons: string[] = [];
  const cleanLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("BTN:")) {
      const label = trimmed.slice(4).trim();
      if (label && label.length <= 64) {
        buttons.push(label);
      }
    } else {
      cleanLines.push(line);
    }
  }

  // Remove trailing empty lines from clean text
  while (cleanLines.length > 0 && cleanLines[cleanLines.length - 1].trim() === "") {
    cleanLines.pop();
  }

  return { cleanText: cleanLines.join("\n"), buttons: buttons.slice(0, 8) };
}

async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  opts?: { replyToMessageId?: number; topicId?: number },
): Promise<number | undefined> {
  // Parse buttons from AI response
  const { cleanText, buttons } = parseButtons(text);
  const finalText = cleanText || text;

  // Build keyboard if buttons found
  let replyMarkup: InlineKeyboard | undefined;
  if (buttons.length > 0) {
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < buttons.length; i++) {
      // Encode button text as callback data (prefix with "ai:" to distinguish)
      keyboard.text(buttons[i], `ai:${buttons[i].slice(0, 60)}`);
      // 2 buttons per row
      if ((i + 1) % 2 === 0 && i < buttons.length - 1) {
        keyboard.row();
      }
    }
    replyMarkup = keyboard;
  }

  try {
    const res = await bot.api.sendMessage(chatId, finalText, {
      parse_mode: "Markdown",
      reply_to_message_id: opts?.replyToMessageId,
      message_thread_id: opts?.topicId,
      reply_markup: replyMarkup,
    });
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      runtime.log?.(
        `telegram markdown parse failed; retrying without formatting: ${errText}`,
      );
      const res = await bot.api.sendMessage(chatId, finalText, {
        reply_to_message_id: opts?.replyToMessageId,
        message_thread_id: opts?.topicId,
        reply_markup: replyMarkup,
      });
      return res.message_id;
    }
    throw err;
  }
}

function describeReplyTarget(msg: TelegramMessage) {
  const reply = msg.reply_to_message;
  if (!reply) return null;
  const replyBody = (reply.text ?? reply.caption ?? "").trim();
  let body = replyBody;
  if (!body) {
    if (reply.photo) body = "<media:image>";
    else if (reply.video) body = "<media:video>";
    else if (reply.audio || reply.voice) body = "<media:audio>";
    else if (reply.document) body = "<media:document>";
  }
  if (!body) return null;
  const sender = buildSenderName(reply);
  const senderLabel = sender ? `${sender}` : "unknown sender";
  return {
    id: reply.message_id ? String(reply.message_id) : undefined,
    sender: senderLabel,
    body,
  };
}
