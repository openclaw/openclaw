// @ts-nocheck
import { Bot, InputFile } from "grammy";

import { mediaKindFromMime } from "../media/constants.js";
import { loadWebMedia } from "../web/media.js";

type TelegramSendOpts = {
  token?: string;
  verbose?: boolean;
  mediaUrl?: string;
  maxBytes?: number;
  api?: Bot["api"];
};

type TelegramSendResult = {
  messageId: string;
  chatId: string;
};

function resolveToken(explicit?: string): string {
  const token = explicit ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is required for Telegram sends (Bot API)",
    );
  }
  return token.trim();
}

function normalizeChatId(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) throw new Error("Recipient is required for Telegram sends");
  if (trimmed.startsWith("@")) return trimmed;
  return trimmed;
}

export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts = {},
): Promise<TelegramSendResult> {
  const token = resolveToken(opts.token);
  const chatId = normalizeChatId(to);
  const bot = opts.api ? null : new Bot(token);
  const api = opts.api ?? bot?.api;
  const mediaUrl = opts.mediaUrl?.trim();

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const sendWithRetry = async <T>(fn: () => Promise<T>, label: string) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const terminal = attempt === 3 ||
          !/429|timeout|connect|reset|closed|unavailable|temporarily/i.test(String(err ?? ""));
        if (terminal) break;
        const backoff = 400 * attempt;
        if (opts.verbose) {
          console.warn(`telegram send retry ${attempt}/2 for ${label} in ${backoff}ms: ${String(err)}`);
        }
        await sleep(backoff);
      }
    }
    throw lastErr ?? new Error(`Telegram send failed (${label})`);
  };

  if (mediaUrl) {
    const media = await loadWebMedia(mediaUrl, opts.maxBytes);
    const kind = mediaKindFromMime(media.contentType ?? undefined);
    const file = new InputFile(
      media.buffer,
      media.fileName ?? inferFilename(kind) ?? "file",
    );
    const caption = text?.trim() || undefined;
    let result:
      | Awaited<ReturnType<typeof api.sendPhoto>>
      | Awaited<ReturnType<typeof api.sendVideo>>
      | Awaited<ReturnType<typeof api.sendAudio>>
      | Awaited<ReturnType<typeof api.sendDocument>>;
    if (kind === "image") {
      result = await sendWithRetry(() => api.sendPhoto(chatId, file, { caption }), "photo");
    } else if (kind === "video") {
      result = await sendWithRetry(() => api.sendVideo(chatId, file, { caption }), "video");
    } else if (kind === "audio") {
      result = await sendWithRetry(() => api.sendAudio(chatId, file, { caption }), "audio");
    } else {
      result = await sendWithRetry(() => api.sendDocument(chatId, file, { caption }), "document");
    }
    const messageId = String(result?.message_id ?? "unknown");
    return { messageId, chatId: String(result?.chat?.id ?? chatId) };
  }

  if (!text || !text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  const res = await sendWithRetry(
    () => api.sendMessage(chatId, text, { parse_mode: "Markdown" }),
    "message",
  );
  const messageId = String(res?.message_id ?? "unknown");
  return { messageId, chatId: String(res?.chat?.id ?? chatId) };
}

function inferFilename(kind: ReturnType<typeof mediaKindFromMime>) {
  switch (kind) {
    case "image":
      return "image.jpg";
    case "video":
      return "video.mp4";
    case "audio":
      return "audio.ogg";
    default:
      return "file.bin";
  }
}
// @ts-nocheck
