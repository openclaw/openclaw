import type { Bot } from "grammy";
import { createFinalizableDraftLifecycle } from "../channels/draft-stream-controls.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;

/**
 * Two streaming modes are supported:
 *
 * 1. **Native draft mode** (`useNativeDraft: true`):
 *    Uses Bot API 9.3's `sendMessageDraft` method to push animated streaming
 *    previews to the client without sending/editing a real message.  Since
 *    Bot API 9.5 (March 1, 2026), this is available to **all** bots — the
 *    earlier forum-topic-mode restriction was lifted.  The method returns
 *    `true` instead of a `Message`, so `messageId()` returns `undefined` in
 *    this mode.  On any API failure the stream automatically falls back to
 *    the legacy path.
 *
 * 2. **Legacy edit mode** (`useNativeDraft: false`, the default):
 *    Sends an initial message via `sendMessage`, then repeatedly edits it via
 *    `editMessageText` as new content arrives.  Compatible with all bots and
 *    chat types, but produces visible "edited" markers and consumes message IDs.
 *
 * @see https://core.telegram.org/bots/api#sendmessagedraft
 * @see https://core.telegram.org/bots/api-changelog#march-1-2026 (Bot API 9.5)
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

type TelegramDraftPreview = {
  text: string;
  parseMode?: "HTML";
};

type SupersededTelegramPreview = {
  messageId: number;
  textSnapshot: string;
  parseMode?: "HTML";
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
  /** Optional preview renderer (e.g. markdown -> HTML + parse mode). */
  renderText?: (text: string) => TelegramDraftPreview;
  /** Called when a late send resolves after forceNewMessage() switched generations. */
  onSupersededPreview?: (preview: SupersededTelegramPreview) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /**
   * When true, use Bot API 9.3+ `sendMessageDraft` for animated streaming
   * previews.  Available to all bots since Bot API 9.5.  Falls back to the
   * legacy editMessageText path on any API failure.
   * Default: false.
   */
  useNativeDraft?: boolean;
  /**
   * Stable non-zero draft identifier for this streaming session.
   * The same `draft_id` animates updates to the same draft bubble.
   * Must be a non-zero int32.  Regenerated on `forceNewMessage()` to start
   * a fresh draft bubble.  Defaults to `Date.now() % 2147483647`.
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
  let draftId =
    params.draftId != null && params.draftId !== 0
      ? params.draftId
      : Math.max(1, Date.now() % 2147483647);
  const messageThreadId = threadParams?.message_thread_id;

  const streamState = { stopped: false, final: false };
  let streamMessageId: number | undefined;
  let lastSentText = "";
  let lastSentParseMode: "HTML" | undefined;
  let generation = 0;

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // Allow final flush even if stopped (e.g., after clear()).
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    const rendered = params.renderText?.(trimmed) ?? { text: trimmed };
    const renderedText = rendered.text.trimEnd();
    const renderedParseMode = rendered.parseMode;
    if (!renderedText) {
      return false;
    }
    if (renderedText.length > maxChars) {
      // Telegram text messages/edits cap at 4096 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      streamState.stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${renderedText.length} > ${maxChars})`,
      );
      return false;
    }
    if (renderedText === lastSentText && renderedParseMode === lastSentParseMode) {
      return true;
    }
    const sendGeneration = generation;

    // Debounce first preview send for better push notification quality.
    // In legacy mode, gate on streamMessageId not yet being set.
    // In native draft mode, gate on lastSentText still being empty (first send).
    const isFirstSend = useNativeDraft ? lastSentText === "" : typeof streamMessageId !== "number";
    if (isFirstSend && minInitialChars != null && !streamState.final) {
      if (renderedText.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = renderedText;
    lastSentParseMode = renderedParseMode;

    // --- Native draft path (Bot API 9.3+) ---
    if (useNativeDraft) {
      try {
        const draftOptions: Record<string, unknown> = {};
        if (messageThreadId != null) {
          draftOptions.message_thread_id = messageThreadId;
        }
        if (renderedParseMode) {
          draftOptions.parse_mode = renderedParseMode;
        }
        await params.api.sendMessageDraft(
          chatId,
          draftId,
          renderedText,
          Object.keys(draftOptions).length > 0 ? draftOptions : undefined,
        );
        return true;
      } catch (err) {
        // Fall back to the legacy editMessageText path on any failure.
        params.warn?.(
          `telegram native draft failed, falling back to legacy edit: ${err instanceof Error ? err.message : String(err)}`,
        );
        useNativeDraft = false;
        // Fall through to the legacy path below.
      }
    }

    // --- Legacy path: sendMessage + editMessageText ---
    try {
      if (typeof streamMessageId === "number") {
        if (renderedParseMode) {
          await params.api.editMessageText(chatId, streamMessageId, renderedText, {
            parse_mode: renderedParseMode,
          });
        } else {
          await params.api.editMessageText(chatId, streamMessageId, renderedText);
        }
        return true;
      }
      const sendParams = renderedParseMode
        ? {
            ...replyParams,
            parse_mode: renderedParseMode,
          }
        : replyParams;
      const sent = await params.api.sendMessage(chatId, renderedText, sendParams);
      const sentMessageId = sent?.message_id;
      if (typeof sentMessageId !== "number" || !Number.isFinite(sentMessageId)) {
        streamState.stopped = true;
        params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
        return false;
      }
      const normalizedMessageId = Math.trunc(sentMessageId);
      if (sendGeneration !== generation) {
        params.onSupersededPreview?.({
          messageId: normalizedMessageId,
          textSnapshot: renderedText,
          parseMode: renderedParseMode,
        });
        return true;
      }
      streamMessageId = normalizedMessageId;
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `telegram stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const { loop, update, stop, clear } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId: () => streamMessageId,
    clearMessageId: () => {
      streamMessageId = undefined;
    },
    isValidMessageId: (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
    deleteMessage: async (messageId) => {
      await params.api.deleteMessage(chatId, messageId);
    },
    onDeleteSuccess: (messageId) => {
      params.log?.(`telegram stream preview deleted (chat=${chatId}, message=${messageId})`);
    },
    warn: params.warn,
    warnPrefix: "telegram stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    generation += 1;
    streamMessageId = undefined;
    lastSentText = "";
    lastSentParseMode = undefined;
    // Regenerate draftId so the next native draft update creates a fresh draft
    // bubble instead of animating the previous one (fixes block-mode splitting).
    if (useNativeDraft) {
      draftId = Math.max(1, Date.now() % 2147483647);
    }
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  params.log?.(
    `telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs}, nativeDraft=${useNativeDraft})`,
  );

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    clear,
    stop,
    forceNewMessage,
  };
}
