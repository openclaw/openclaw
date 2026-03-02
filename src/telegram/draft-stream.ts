import type { Bot } from "grammy";
import { createFinalizableDraftLifecycle } from "../channels/draft-stream-controls.js";
import { sendMessageDraft } from "./draft-message-api.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;

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

/**
 * Stable draft ID for a streaming session. Must be a non-zero integer and
 * must stay the same across all `sendMessageDraft` calls for the same
 * animated stream. We derive it from the chatId so it is deterministic and
 * avoids collisions between concurrent streams to different chats.
 *
 * Telegram animates the growing text as a typing stream in the client as long
 * as the same draft_id is reused. On `flush()` we finalize with `sendMessage`
 * which replaces the draft with a permanent message.
 */
function deriveDraftId(chatId: number): number {
  // Use the lower 31 bits of chatId (always positive, non-zero).
  const id = Math.abs(chatId) & 0x7fffffff;
  return id === 0 ? 1 : id;
}

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
  /**
   * When true (default), use `sendMessageDraft` (Bot API 9.5+) for in-progress
   * streaming previews. The final flush always uses `sendMessage`.
   * Set to false to fall back to the legacy send-then-edit approach.
   */
  useSendMessageDraft?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
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
  // Default to using sendMessageDraft; can be disabled via config for older bot tokens.
  const useSendMessageDraft = params.useSendMessageDraft !== false;
  const draftId = deriveDraftId(chatId);

  const streamState = { stopped: false, final: false };
  let streamMessageId: number | undefined;
  let lastSentText = "";
  let lastSentParseMode: "HTML" | undefined;
  let generation = 0;
  // Track whether we've successfully used sendMessageDraft at least once.
  // If the first call fails (e.g. old Bot API version), we fall back to legacy.
  let draftApiConfirmed = false;
  let draftApiFailed = false;

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
      streamState.stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${renderedText.length} > ${maxChars})`,
      );
      return false;
    }
    if (renderedText === lastSentText && renderedParseMode === lastSentParseMode) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
    if (typeof streamMessageId !== "number" && minInitialChars != null && !streamState.final) {
      if (renderedText.length < minInitialChars) {
        return false;
      }
    }

    const sendGeneration = generation;
    lastSentText = renderedText;
    lastSentParseMode = renderedParseMode;

    try {
      // ----------------------------------------------------------------
      // In-progress (non-final) update: prefer sendMessageDraft.
      // On the final flush, streamState.final is true and we fall through
      // to sendMessage so the draft is replaced with a permanent message.
      // ----------------------------------------------------------------
      if (useSendMessageDraft && !streamState.final && !draftApiFailed) {
        const ok = await sendMessageDraft(params.api, {
          chat_id: chatId,
          draft_id: draftId,
          text: renderedText,
          ...(renderedParseMode ? { parse_mode: renderedParseMode } : {}),
          ...(threadParams?.message_thread_id != null
            ? { message_thread_id: threadParams.message_thread_id }
            : {}),
        });
        if (ok) {
          draftApiConfirmed = true;
          // sendMessageDraft does not return a message_id; the permanent
          // message_id is only known after the final sendMessage call.
          return true;
        }
        // ok=false means a non-fatal API rejection (rate limit, unknown method,
        // etc.). Fall through to the legacy path.
        if (!draftApiConfirmed) {
          // First call failed — disable for this session to avoid repeated failures.
          draftApiFailed = true;
          params.warn?.(
            "telegram sendMessageDraft returned ok=false; falling back to send-then-edit",
          );
        }
      }

      // ----------------------------------------------------------------
      // Legacy path: send once, then edit on subsequent updates.
      // Also used for the final flush when draftApiConfirmed so the draft
      // is replaced with a permanent message.
      // ----------------------------------------------------------------
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
        ? { ...replyParams, parse_mode: renderedParseMode }
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
      if (useSendMessageDraft && !draftApiConfirmed && !draftApiFailed) {
        // First sendMessageDraft threw — likely unsupported by this bot token.
        // Disable and allow the lifecycle to retry via the legacy path.
        draftApiFailed = true;
        const errMsg = err instanceof Error ? err.message : String(err);
        params.warn?.(
          `telegram sendMessageDraft failed; falling back to send-then-edit: ${errMsg}`,
        );
        return false;
      }
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
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  params.log?.(
    `telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs}, ` +
      `draftApi=${useSendMessageDraft})`,
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
