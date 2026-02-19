import type { Bot } from "grammy";
import { createDraftStreamLoop } from "../channels/draft-stream-loop.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;

/**
 * Two streaming modes are supported:
 *
 * 1. **Native draft mode** (`useNativeDraft: true`):
 *    Uses Bot API 9.3's `sendMessageDraft` method to push animated streaming
 *    previews to the client without sending/editing a real message. This is
 *    only available for bots that have forum topic mode enabled
 *    (`has_topics_enabled: true`). The method returns `true` instead of a
 *    `Message`, so `messageId()` returns `undefined` in this mode. On any
 *    API failure the stream automatically falls back to the legacy path.
 *
 * 2. **Legacy edit mode** (`useNativeDraft: false`, the default):
 *    Sends an initial message via `sendMessage`, then repeatedly edits it via
 *    `editMessageText` as new content arrives. Compatible with all bots and
 *    chat types, but produces visible "edited" markers and consumes message IDs.
 */

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
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
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /**
   * When true, use Bot API 9.3 `sendMessageDraft` for animated streaming previews.
   * Requires the bot to have forum topic mode enabled. Falls back to the legacy
   * editMessageText path on any API failure.
   * Default: false.
   */
  useNativeDraft?: boolean;
  /**
   * Stable non-zero draft identifier for this streaming session.
   * The same `draft_id` animates updates to the same draft bubble.
   * Must be a non-zero int32. Defaults to `Date.now() % 2147483647`.
   */
  draftId?: number;
}): TelegramDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const chatId = params.chatId;
  const threadParams = buildTelegramThreadParams(params.thread);
  const replyParams =
    params.replyToMessageId != null
      ? { ...threadParams, reply_to_message_id: params.replyToMessageId }
      : threadParams;

  // Native draft state
  let useNativeDraft = params.useNativeDraft === true;
  const draftId =
    params.draftId != null && params.draftId !== 0
      ? params.draftId
      : Math.max(1, Date.now() % 2147483647);
  // message_thread_id is required when forum topic mode is enabled
  const messageThreadId = threadParams?.message_thread_id;

  let streamMessageId: number | undefined;
  let lastSentText = "";
  let stopped = false;
  let isFinal = false;

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // Allow final flush even if stopped (e.g., after clear()).
    if (stopped && !isFinal) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      // Telegram text messages/edits cap at 4096 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${trimmed.length} > ${maxChars})`,
      );
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
    // In legacy mode, gate on streamMessageId not yet being set.
    // In native draft mode, gate on lastSentText still being empty (first send).
    const isFirstSend = useNativeDraft ? lastSentText === "" : typeof streamMessageId !== "number";
    if (isFirstSend && minInitialChars != null && !isFinal) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = trimmed;

    // --- Native draft path (Bot API 9.3) ---
    if (useNativeDraft) {
      try {
        await params.api.sendMessageDraft(
          chatId,
          draftId,
          trimmed,
          messageThreadId != null ? { message_thread_id: messageThreadId } : undefined,
        );
        return true;
      } catch (err) {
        // Fall back to the legacy editMessageText path on any failure.
        params.warn?.(
          `telegram native draft failed, falling back to editMessageText: ${err instanceof Error ? err.message : String(err)}`,
        );
        useNativeDraft = false;
        // Fall through to the legacy path below.
      }
    }

    // --- Legacy path: sendMessage + editMessageText ---
    try {
      if (typeof streamMessageId === "number") {
        await params.api.editMessageText(chatId, streamMessageId, trimmed);
        return true;
      }
      const sent = await params.api.sendMessage(chatId, trimmed, replyParams);
      const sentMessageId = sent?.message_id;
      if (typeof sentMessageId !== "number" || !Number.isFinite(sentMessageId)) {
        stopped = true;
        params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
        return false;
      }
      streamMessageId = Math.trunc(sentMessageId);
      return true;
    } catch (err) {
      stopped = true;
      params.warn?.(
        `telegram stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const loop = createDraftStreamLoop({
    throttleMs,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  const update = (text: string) => {
    if (stopped || isFinal) {
      return;
    }
    loop.update(text);
  };

  const stop = async (): Promise<void> => {
    isFinal = true;
    await loop.flush();
  };

  const clear = async () => {
    stopped = true;
    loop.stop();
    await loop.waitForInFlight();
    const messageId = streamMessageId;
    streamMessageId = undefined;
    if (typeof messageId !== "number") {
      // In native draft mode there is no real message to delete.
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

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(
    `telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs}, nativeDraft=${useNativeDraft})`,
  );

  return {
    update,
    flush: loop.flush,
    /**
     * Returns the Telegram message ID of the in-progress preview message.
     * In native draft mode this is always `undefined` because `sendMessageDraft`
     * does not create a regular message.
     */
    messageId: () => streamMessageId,
    clear,
    stop,
    forceNewMessage,
  };
}
