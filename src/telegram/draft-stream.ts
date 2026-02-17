import type { Bot } from "grammy";
import { createDraftStreamLoop } from "../channels/draft-stream-loop.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  clear: () => Promise<void>;
  stop: () => void;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
};

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: number;
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  replyToMessageId?: number;
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
  const replyParams =
    params.replyToMessageId != null
      ? { ...threadParams, reply_to_message_id: params.replyToMessageId }
      : threadParams;

  let streamMessageId: number | undefined;
  let lastSentText = "";
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
    try {
      if (typeof streamMessageId === "number") {
        await params.api.editMessageText(chatId, streamMessageId, trimmed);
        return;
      }
      const sent = await params.api.sendMessage(chatId, trimmed, replyParams);
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
  const loop = createDraftStreamLoop({
    throttleMs,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  const clear = async () => {
    stop();
    await loop.waitForInFlight();
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

  const stop = () => {
    stopped = true;
    loop.stop();
  };

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update: loop.update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    clear,
    stop,
    forceNewMessage,
  };
}
