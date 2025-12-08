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
      result = await api.sendPhoto(chatId, file, { caption });
    } else if (kind === "video") {
      result = await api.sendVideo(chatId, file, { caption });
    } else if (kind === "audio") {
      result = await api.sendAudio(chatId, file, { caption });
    } else {
      result = await api.sendDocument(chatId, file, { caption });
    }
    const messageId = String(result?.message_id ?? "unknown");
    return { messageId, chatId: String(result?.chat?.id ?? chatId) };
  }

  if (!text || !text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  const res = await api.sendMessage(chatId, text, {
    parse_mode: "Markdown",
  });
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
