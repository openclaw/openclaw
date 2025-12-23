// @ts-nocheck
import { Buffer } from "node:buffer";

import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions, Message } from "grammy";
import { Bot, InputFile, webhookCallback } from "grammy";

import { chunkText } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, isVerbose, logVerbose } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { mediaKindFromMime } from "../media/constants.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadWebMedia } from "../web/media.js";

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
  const requireMention =
    opts.requireMention ?? cfg.telegram?.requireMention ?? true;
  const allowFrom = opts.allowFrom ?? cfg.telegram?.allowFrom;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.telegram?.mediaMaxMb ?? 5) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) return;
      const chatId = msg.chat.id;
      const isGroup =
        msg.chat.type === "group" || msg.chat.type === "supergroup";

      const sendTyping = async () => {
        try {
          await bot.api.sendChatAction(chatId, "typing");
        } catch (err) {
          logVerbose(
            `telegram typing cue failed for chat ${chatId}: ${String(err)}`,
          );
        }
      };

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
      if (
        isGroup &&
        requireMention &&
        botUsername &&
        !hasBotMention(msg, botUsername)
      ) {
        logger.info({ chatId, reason: "no-mention" }, "skipping group message");
        return;
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
      const body = formatAgentEnvelope({
        surface: "Telegram",
        from: isGroup
          ? buildGroupLabel(msg, chatId)
          : buildSenderLabel(msg, chatId),
        timestamp: msg.date ? msg.date * 1000 : undefined,
        body: rawBody,
      });

      const ctxPayload = {
        Body: body,
        From: isGroup ? `group:${chatId}` : `telegram:${chatId}`,
        To: `telegram:${chatId}`,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
        SenderName: buildSenderName(msg),
        Surface: "telegram",
        MessageSid: String(msg.message_id),
        ReplyToId: replyTarget?.id,
        ReplyToBody: replyTarget?.body,
        ReplyToSender: replyTarget?.sender,
        Timestamp: msg.date ? msg.date * 1000 : undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
      };

      if (replyTarget && isVerbose()) {
        const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
        logVerbose(
          `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
        );
      }

      if (!isGroup) {
        const sessionCfg = cfg.inbound?.session;
        const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
        const storePath = resolveStorePath(sessionCfg?.store);
        await updateLastRoute({
          storePath,
          sessionKey: mainKey,
          channel: "telegram",
          to: String(chatId),
        });
      }

      if (isVerbose()) {
        const preview = body.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
        );
      }

      const replyResult = await getReplyFromConfig(
        ctxPayload,
        { onReplyStart: sendTyping },
        cfg,
      );
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      if (replies.length === 0) return;

      await deliverReplies({
        replies,
        chatId: String(chatId),
        token: opts.token,
        runtime,
        bot,
        replyToMessageId: msg.message_id,
      });
    } catch (err) {
      runtime.error?.(danger(`Telegram handler failed: ${String(err)}`));
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
  replyToMessageId?: number;
}) {
  const { replies, chatId, runtime, bot } = params;
  const replyTarget = params.replyToMessageId;
  for (const reply of replies) {
    if (!reply?.text && !reply?.mediaUrl && !(reply?.mediaUrls?.length ?? 0)) {
      runtime.error?.(danger("Telegram reply missing text/media"));
      continue;
    }
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];
    if (replyTarget && isVerbose()) {
      logVerbose(
        `telegram reply-send: chatId=${chatId} replyToMessageId=${replyTarget} kind=${mediaList.length ? "media" : "text"}`,
      );
    }
    if (mediaList.length === 0) {
      for (const chunk of chunkText(reply.text || "", 4000)) {
        await sendTelegramText(bot, chatId, chunk, runtime, replyTarget);
      }
      continue;
    }
    // media with optional caption on first item
    let first = true;
    for (const mediaUrl of mediaList) {
      const media = await loadWebMedia(mediaUrl);
      const kind = mediaKindFromMime(media.contentType ?? undefined);
      const file = new InputFile(media.buffer, media.fileName ?? "file");
      const caption = first ? (reply.text ?? undefined) : undefined;
      first = false;
      const replyOpts = replyTarget ? { reply_to_message_id: replyTarget } : {};
      if (kind === "image") {
        await bot.api.sendPhoto(chatId, file, { caption, ...replyOpts });
      } else if (kind === "video") {
        await bot.api.sendVideo(chatId, file, { caption, ...replyOpts });
      } else if (kind === "audio") {
        await bot.api.sendAudio(chatId, file, { caption, ...replyOpts });
      } else {
        await bot.api.sendDocument(chatId, file, {
          caption,
          ...replyOpts,
        });
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

async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  replyToMessageId?: number,
): Promise<number | undefined> {
  try {
    const res = await bot.api.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_to_message_id: replyToMessageId,
    });
    return res.message_id;
  } catch (err) {
    if (PARSE_ERR_RE.test(String(err ?? ""))) {
      runtime.log?.(
        `telegram markdown parse failed; retrying without formatting: ${String(
          err,
        )}`,
      );
      const res = await bot.api.sendMessage(chatId, text, {
        reply_to_message_id: replyToMessageId,
      });
      return res.message_id;
    }
    throw err;
  }
}

function describeReplyTarget(msg: TelegramMessage) {
  const reply = msg.reply_to_message as TelegramMessage | undefined;
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
