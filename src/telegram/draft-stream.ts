import type { Bot } from "grammy";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  clear: () => Promise<void>;
  stop: () => void;
};

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: number;
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  throttleMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const chatId = params.chatId;
  const threadParams = buildTelegramThreadParams(params.thread);

  let streamMessageId: number | undefined;
  let lastSentText = "";
  let lastSentAt = 0;
  let pendingText = "";
  let inFlightPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const sendOrEditStreamMessage = async (text: string) => {
    if (stopped) {
      return;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (trimmed.length > maxChars) {
      // Telegram text messages/edits cap at 4096 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${trimmed.length} > ${maxChars})`,
      );
      return;
    }
    if (trimmed === lastSentText) {
      return;
    }
    lastSentText = trimmed;
    lastSentAt = Date.now();
    try {
      if (typeof streamMessageId === "number") {
        await params.api.editMessageText(chatId, streamMessageId, trimmed);
        return;
      }
      const sent = await params.api.sendMessage(chatId, trimmed, threadParams);
      const sentMessageId = sent?.message_id;
      if (typeof sentMessageId !== "number" || !Number.isFinite(sentMessageId)) {
        stopped = true;
        params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
        return;
      }
      streamMessageId = Math.trunc(sentMessageId);
    } catch (err) {
      stopped = true;
      params.warn?.(
        `telegram stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!stopped) {
      if (inFlightPromise) {
        await inFlightPromise;
        continue;
      }
      const text = pendingText;
      const trimmed = text.trim();
      if (!trimmed) {
        pendingText = "";
        return;
      }
      pendingText = "";
      const current = sendOrEditStreamMessage(text).finally(() => {
        if (inFlightPromise === current) {
          inFlightPromise = undefined;
        }
      });
      inFlightPromise = current;
      await current;
      if (!pendingText) {
        return;
      }
    }
  };

  const clear = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    pendingText = "";
    stopped = true;
    if (inFlightPromise) {
      await inFlightPromise;
    }
    const messageId = streamMessageId;
    streamMessageId = undefined;
    if (typeof messageId !== "number") {
      return;
    }
    try {
      await params.api.deleteMessage(chatId, messageId);
    } catch (err) {
      params.warn?.(
        `telegram stream preview cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      void flush();
    }, delay);
  };

  const update = (text: string) => {
    if (stopped) {
      return;
    }
    pendingText = text;
    if (inFlightPromise) {
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= throttleMs) {
      void flush();
      return;
    }
    schedule();
  };

  const stop = () => {
    stopped = true;
    pendingText = "";
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush,
    messageId: () => streamMessageId,
    clear,
    stop,
  };
}
