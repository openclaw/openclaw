import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isToolCallContentType,
  isToolErrorOutput,
  isToolResultContentType,
  readToolErrorFlag,
} from "../../chat/tool-content.js";
import { readTranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { logLargePayload } from "../../logging/diagnostic-payload.js";
import {
  extractChatHistoryBlockText,
  extractChatToolResultCanvasPreview,
} from "../chat-display-projection.canvas.js";
import {
  hasTranscriptMediaFacts,
  isAssistantInternalReasoningContentType,
  isAssistantTextContentType,
} from "../chat-display-projection.helpers.js";

export const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const CHAT_HISTORY_UNAVAILABLE_SENTINEL =
  "[chat.history unavailable: transcript too large to display; the full history is preserved on disk]";
let chatHistoryOmittedEmitCount = 0;

export function createChatHistoryByteCounter() {
  const sizes = new Map<unknown, number>();
  const messageBytes = (message: unknown): number => {
    const cached = sizes.get(message);
    if (cached !== undefined) {
      return cached;
    }
    const bytes = jsonUtf8Bytes(message);
    sizes.set(message, bytes);
    return bytes;
  };
  return {
    messageBytes,
    messagesBytes: (messages: unknown[]) =>
      2 +
      messages.reduce<number>((bytes, message) => bytes + messageBytes(message), 0) +
      Math.max(0, messages.length - 1),
  };
}

function hasHistoryToolPresentation(
  message: Record<string, unknown>,
  inheritedError?: boolean,
): boolean {
  return Boolean(
    asOptionalRecord(message.details) ||
    (readToolErrorFlag(message) ?? inheritedError) === true ||
    extractChatToolResultCanvasPreview(message),
  );
}

function isPlainHistoryToolResult(
  message: Record<string, unknown>,
  inheritedError?: boolean,
): boolean {
  if (
    hasHistoryToolPresentation(message, inheritedError) ||
    (readToolErrorFlag(message) ??
      inheritedError ??
      isToolErrorOutput(extractChatHistoryBlockText(message)))
  ) {
    return false;
  }
  const content = message.content ?? message.text;
  return (
    content === undefined ||
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.every((block) => {
        const entry = asOptionalRecord(block);
        return isAssistantTextContentType(entry?.type) && typeof entry?.text === "string";
      }))
  );
}

function isChatHistoryActivity(message: unknown): boolean {
  const entry = asOptionalRecord(message);
  if (!entry || hasTranscriptMediaFacts(entry) || hasHistoryToolPresentation(entry)) {
    return false;
  }
  const metadata = asOptionalRecord(entry["__openclaw"]);
  if (
    metadata?.kind !== undefined ||
    metadata?.turnBoundary === true ||
    metadata?.replyToId !== undefined ||
    metadata?.replyToPreview !== undefined ||
    entry.openclawDelivery !== undefined ||
    entry.stopReason === "error"
  ) {
    return false;
  }
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role === "toolresult" || role === "tool_result" || role === "tool" || role === "function") {
    return isPlainHistoryToolResult(entry);
  }
  if (
    (role !== "assistant" && role !== "user") ||
    (typeof entry.text === "string" && entry.text.trim()) ||
    !Array.isArray(entry.content) ||
    entry.content.length === 0
  ) {
    return false;
  }
  // Tool rows can also carry canvas previews, media, or other visible outcomes.
  // Only known activity without such presentation is eligible for trimming.
  return entry.content.every((block) => {
    const content = asOptionalRecord(block);
    if (!content) {
      return false;
    }
    return isToolResultContentType(content.type)
      ? isPlainHistoryToolResult(content, readToolErrorFlag(entry))
      : !hasHistoryToolPresentation(content, readToolErrorFlag(entry)) &&
          (isToolCallContentType(content.type) ||
            isAssistantInternalReasoningContentType(content.type));
  });
}

export function trimChatHistoryActivity(params: {
  messages: unknown[];
  maxBytes: number;
  byteCounter: ReturnType<typeof createChatHistoryByteCounter>;
}): unknown[] {
  const { messages, maxBytes, byteCounter } = params;
  let bytes = byteCounter.messagesBytes(messages);
  if (bytes <= maxBytes) {
    return messages;
  }
  let remaining = messages.length;
  return messages.filter((message) => {
    if (bytes <= maxBytes || !isChatHistoryActivity(message)) {
      return true;
    }
    bytes -= byteCounter.messageBytes(message) + (remaining > 1 ? 1 : 0);
    remaining -= 1;
    return false;
  });
}

function buildChatHistoryUnavailableSentinel(): Record<string, unknown> {
  return {
    role: "assistant",
    timestamp: Date.now(),
    content: [{ type: "text", text: CHAT_HISTORY_UNAVAILABLE_SENTINEL }],
  };
}

function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const timestamp =
    message &&
    typeof message === "object" &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  const rawMetadata =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)["__openclaw"]
      : undefined;
  const metadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {};
  const metadataId = typeof metadata.id === "string" ? metadata.id : undefined;
  const metadataSeq = typeof metadata.seq === "number" ? metadata.seq : undefined;
  const metadataIdempotencyKey =
    typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey : undefined;
  const turnBoundary = metadata.turnBoundary === true;
  const transcriptPosition = readTranscriptDisplayPosition(metadata.transcriptPosition);
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: {
      ...(metadataId ? { id: metadataId } : {}),
      ...(metadataSeq !== undefined ? { seq: metadataSeq } : {}),
      ...(metadataIdempotencyKey ? { idempotencyKey: metadataIdempotencyKey } : {}),
      ...(turnBoundary ? { turnBoundary: true } : {}),
      ...(transcriptPosition ? { transcriptPosition } : {}),
      truncated: true,
      reason: "oversized",
    },
  };
}

export function replaceOversizedChatHistoryMessages(params: {
  byteCounter?: ReturnType<typeof createChatHistoryByteCounter>;
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  const byteCounter = params.byteCounter ?? createChatHistoryByteCounter();
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0;
  const next = messages.map((message) => {
    if (byteCounter.messageBytes(message) <= maxSingleMessageBytes) {
      return message;
    }
    replacedCount += 1;
    const placeholder = buildOversizedHistoryPlaceholder(message);
    return byteCounter.messageBytes(placeholder) <= maxSingleMessageBytes
      ? placeholder
      : buildChatHistoryUnavailableSentinel();
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount };
}

export function reportOmittedChatHistory(params: {
  originalMessages: unknown[];
  finalMessages: unknown[];
  getNormalizedBytes: () => number;
  maxHistoryBytes: number;
  logDebug: (message: string) => void;
}): number {
  const { originalMessages, finalMessages, getNormalizedBytes, maxHistoryBytes, logDebug } = params;
  const survivors = new Set(finalMessages);
  let omittedCount = 0;
  for (const message of originalMessages) {
    if (!survivors.has(message)) {
      omittedCount += 1;
    }
  }
  if (omittedCount === 0) {
    return 0;
  }
  chatHistoryOmittedEmitCount += omittedCount;
  logLargePayload({
    surface: "gateway.chat.history",
    action: "truncated",
    bytes: getNormalizedBytes(),
    limitBytes: maxHistoryBytes,
    count: omittedCount,
    reason: "chat_history_budget",
  });
  logDebug(
    `chat.history omitted oversized payloads count=${omittedCount} total=${chatHistoryOmittedEmitCount}`,
  );
  return omittedCount;
}
