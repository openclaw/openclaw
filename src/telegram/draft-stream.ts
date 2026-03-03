import type { Bot } from "grammy";
import { createFinalizableDraftLifecycle } from "../channels/draft-stream-controls.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const DRAFT_METHOD_UNAVAILABLE_RE =
  /(unknown method|method .*not (found|available|supported)|unsupported)/i;
const DRAFT_CHAT_UNSUPPORTED_RE = /(can't be used|can be used only)/i;
const RTL_SCRIPT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const BIDI_CONTROL_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const RTL_DIRECTION_MARK = "\u200F";

type TelegramSendMessageDraft = (
  chatId: number,
  draftId: number,
  text: string,
  params?: {
    message_thread_id?: number;
    parse_mode?: "HTML";
  },
) => Promise<unknown>;

let nextDraftId = 0;

function allocateTelegramDraftId(): number {
  nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
  return nextDraftId;
}

function resolveSendMessageDraftApi(api: Bot["api"]): TelegramSendMessageDraft | undefined {
  const sendMessageDraft = (api as Bot["api"] & { sendMessageDraft?: TelegramSendMessageDraft })
    .sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return undefined;
  }
  return sendMessageDraft.bind(api as object);
}

function shouldFallbackFromDraftTransport(err: unknown): boolean {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err && "description" in err
          ? typeof err.description === "string"
            ? err.description
            : ""
          : "";
  if (!/sendMessageDraft/i.test(text)) {
    return false;
  }
  return DRAFT_METHOD_UNAVAILABLE_RE.test(text) || DRAFT_CHAT_UNSUPPORTED_RE.test(text);
}

function applyDraftDirectionalityHint(text: string, parseMode?: "HTML"): string {
  if (parseMode === "HTML") {
    return text;
  }
  if (!RTL_SCRIPT_RE.test(text) || BIDI_CONTROL_RE.test(text)) {
    return text;
  }
  return `${RTL_DIRECTION_MARK}${text}`;
}

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  previewMode?: () => "message" | "draft";
  previewRevision?: () => number;
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
  previewTransport?: "auto" | "message" | "draft";
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
}): TelegramDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const chatId = params.chatId;
  const requestedPreviewTransport = params.previewTransport ?? "auto";
  const prefersDraftTransport =
    requestedPreviewTransport === "draft"
      ? true
      : requestedPreviewTransport === "message"
        ? false
        : params.thread?.scope === "dm";
  const threadParams = buildTelegramThreadParams(params.thread);
  const replyParams =
    params.replyToMessageId != null
      ? { ...threadParams, reply_to_message_id: params.replyToMessageId }
      : threadParams;
  const resolvedDraftApi = prefersDraftTransport
    ? resolveSendMessageDraftApi(params.api)
    : undefined;
  const usesDraftTransport = Boolean(prefersDraftTransport && resolvedDraftApi);
  if (prefersDraftTransport && !usesDraftTransport) {
    params.warn?.(
      "telegram stream preview: sendMessageDraft unavailable; falling back to sendMessage/editMessageText",
    );
  }

  const streamState = { stopped: false, final: false };
  let streamMessageId: number | undefined;
  let streamDraftId = usesDraftTransport ? allocateTelegramDraftId() : undefined;
  let previewTransport: "message" | "draft" = usesDraftTransport ? "draft" : "message";
  let lastSentText = "";
  let lastSentParseMode: "HTML" | undefined;
  let previewRevision = 0;
  let generation = 0;
  type PreviewSendParams = {
    renderedText: string;
    renderedParseMode: "HTML" | undefined;
    sendGeneration: number;
  };
  const sendMessageTransportPreview = async ({
    renderedText,
    renderedParseMode,
    sendGeneration,
  }: PreviewSendParams): Promise<boolean> => {
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
    let sent;
    try {
      sent = await params.api.sendMessage(chatId, renderedText, sendParams);
    } catch (err) {
      const hasThreadParam =
        "message_thread_id" in (sendParams ?? {}) &&
        typeof (sendParams as { message_thread_id?: unknown }).message_thread_id === "number";
      if (!hasThreadParam || !THREAD_NOT_FOUND_RE.test(String(err))) {
        throw err;
      }
      const threadlessParams = {
        ...(sendParams as Record<string, unknown>),
      };
      delete threadlessParams.message_thread_id;
      params.warn?.(
        "telegram stream preview send failed with message_thread_id, retrying without thread",
      );
      sent = await params.api.sendMessage(
        chatId,
        renderedText,
        Object.keys(threadlessParams).length > 0 ? threadlessParams : undefined,
      );
    }
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
  };
  const sendDraftTransportPreview = async ({
    renderedText,
    renderedParseMode,
  }: PreviewSendParams): Promise<boolean> => {
    const draftId = streamDraftId ?? allocateTelegramDraftId();
    streamDraftId = draftId;
    const draftParams = {
      ...(threadParams?.message_thread_id != null
        ? { message_thread_id: threadParams.message_thread_id }
        : {}),
      ...(renderedParseMode ? { parse_mode: renderedParseMode } : {}),
    };
    await resolvedDraftApi!(
      chatId,
      draftId,
      renderedText,
      Object.keys(draftParams).length > 0 ? draftParams : undefined,
    );
    return true;
  };

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
    const transportText =
      previewTransport === "draft"
        ? applyDraftDirectionalityHint(renderedText, renderedParseMode)
        : renderedText;
    if (transportText.length > maxChars) {
      // Telegram text messages/edits cap at 4096 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      streamState.stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${transportText.length} > ${maxChars})`,
      );
      return false;
    }
    if (transportText === lastSentText && renderedParseMode === lastSentParseMode) {
      return true;
    }
    const sendGeneration = generation;

    // Debounce first preview send for better push notification quality.
    if (typeof streamMessageId !== "number" && minInitialChars != null && !streamState.final) {
      if (renderedText.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = transportText;
    lastSentParseMode = renderedParseMode;
    try {
      let sent = false;
      if (previewTransport === "draft") {
        try {
          sent = await sendDraftTransportPreview({
            renderedText: transportText,
            renderedParseMode,
            sendGeneration,
          });
        } catch (err) {
          if (!shouldFallbackFromDraftTransport(err)) {
            throw err;
          }
          previewTransport = "message";
          streamDraftId = undefined;
          params.warn?.(
            "telegram stream preview: sendMessageDraft rejected by API; falling back to sendMessage/editMessageText",
          );
          sent = await sendMessageTransportPreview({
            renderedText: transportText,
            renderedParseMode,
            sendGeneration,
          });
        }
      } else {
        sent = await sendMessageTransportPreview({
          renderedText: transportText,
          renderedParseMode,
          sendGeneration,
        });
      }
      if (sent) {
        previewRevision += 1;
      }
      return sent;
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
    if (previewTransport === "draft") {
      streamDraftId = allocateTelegramDraftId();
    }
    lastSentText = "";
    lastSentParseMode = undefined;
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    previewMode: () => previewTransport,
    previewRevision: () => previewRevision,
    clear,
    stop,
    forceNewMessage,
  };
}
