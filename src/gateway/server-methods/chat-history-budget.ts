import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
  readToolErrorFlag,
} from "../../chat/tool-content.js";
import { readTranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import type { AgentHistoryActivity } from "../../infra/agent-activity-events.js";
import { jsonUtf8Bytes, jsonUtf8BytesOrInfinity } from "../../infra/json-utf8-bytes.js";
import { logLargePayload } from "../../logging/diagnostic-payload.js";
import type { InFlightRunSnapshot } from "../chat-inflight-snapshot.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";

export const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const CHAT_HISTORY_UNAVAILABLE_SENTINEL =
  "[chat.history unavailable: transcript too large to display; the full history is preserved on disk]";
let chatHistoryOmittedEmitCount = 0;

export function createChatHistoryActivityProjection(
  messages: unknown[],
  activity: readonly AgentHistoryActivity[] = [],
) {
  const byId = new Map(activity.map((entry) => [entry.messageId, entry]));
  return new Map(
    messages.flatMap((message) => {
      const messageId = readChatHistoryMessageId(message);
      const entry = messageId ? byId.get(messageId) : undefined;
      const record = asOptionalRecord(message);
      const toolBearing =
        record &&
        (isToolResultContentType(record.role) ||
          record.role === "tool" ||
          record.role === "function" ||
          (Array.isArray(record.content) &&
            record.content.some((block) => {
              const type = asOptionalRecord(block)?.type;
              return isToolCallContentType(type) || isToolResultContentType(type);
            })));
      return entry && toolBearing ? [[message, entry] as const] : [];
    }),
  );
}

export function createChatHistoryByteCounter(
  activity?: ReadonlyMap<unknown, AgentHistoryActivity>,
) {
  const sizes = new Map<unknown, number>();
  const messageBytes = (message: unknown): number => {
    const cached = sizes.get(message);
    if (cached !== undefined) {
      return cached;
    }
    const descriptor = activity?.get(message);
    const bytes = jsonUtf8Bytes(message) + (descriptor ? jsonUtf8Bytes(descriptor) + 1 : 0);
    sizes.set(message, bytes);
    return bytes;
  };
  return {
    messageBytes,
    framingBytes: (messages: unknown[]) =>
      messages.some((message) => activity?.has(message)) ? 13 : 0,
    messagesBytes: (messages: unknown[]) =>
      (messages.some((message) => activity?.has(message)) ? 15 : 2) +
      messages.reduce<number>((bytes, message) => bytes + messageBytes(message), 0) +
      Math.max(0, messages.length - 1),
  };
}

export function chatHistoryActivityBytes(activity: readonly AgentHistoryActivity[]): number {
  return activity.length > 0 ? jsonUtf8Bytes({ activity }) - 1 : 0;
}

/** Delta envelopes share one prepared plain-data snapshot throughout their synchronous projection. */
export function createChatHistoryDeltaByteCounter(sessionSnapshot: Record<string, unknown>) {
  let snapshot: { bytes: number; keys: Set<string> } | undefined;
  return (envelope: Record<string, unknown>): number => {
    snapshot ??= {
      bytes: jsonUtf8BytesOrInfinity(sessionSnapshot),
      keys: new Set(Object.keys(sessionSnapshot)),
    };
    const fields: Record<string, unknown> = {};
    for (const key in envelope) {
      // The snapshot is the final writer, including keys whose undefined value omits a field.
      if (!snapshot.keys.has(key) && Object.hasOwn(envelope, key)) {
        fields[key] = envelope[key];
      }
    }
    const fieldsBytes = jsonUtf8BytesOrInfinity(fields);
    // Merge the object bodies with one brace pair and, when both have fields, one comma.
    return snapshot.bytes + fieldsBytes - 2 + (snapshot.bytes > 2 && fieldsBytes > 2 ? 1 : 0);
  };
}

function buildChatHistoryUnavailableSentinel(): Record<string, unknown> {
  return {
    role: "assistant",
    timestamp: Date.now(),
    content: [{ type: "text", text: CHAT_HISTORY_UNAVAILABLE_SENTINEL }],
  };
}

export function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const entry = asOptionalRecord(message) ?? {};
  const role = typeof entry.role === "string" ? entry.role : "assistant";
  const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.now();
  const metadata = asOptionalRecord(entry["__openclaw"]) ?? {};
  // A bounded placeholder still identifies the tool so callers can reopen its
  // durable row. The caller checks this envelope against the byte cap as well.
  const toolIdentity = Object.fromEntries(
    ["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "toolName", "tool_name", "name"]
      .filter((key) => typeof entry[key] === "string")
      .map((key) => [key, entry[key]]),
  );
  const isError = readToolErrorFlag(entry);
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
    ...toolIdentity,
    ...(isError !== undefined ? { isError } : {}),
    __openclaw: {
      ...(metadata.toolOutput ? { toolOutput: metadata.toolOutput } : {}),
      ...(metadataId ? { id: metadataId } : {}),
      ...(typeof metadata.runId === "string" ? { runId: metadata.runId } : {}),
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
  omittedCount: number;
  normalizedBytes: number;
  maxHistoryBytes: number;
  logDebug: (message: string) => void;
}): number {
  const { omittedCount, normalizedBytes, maxHistoryBytes, logDebug } = params;
  if (omittedCount === 0) {
    return 0;
  }
  chatHistoryOmittedEmitCount += omittedCount;
  logLargePayload({
    surface: "gateway.chat.history",
    action: "truncated",
    bytes: normalizedBytes,
    limitBytes: maxHistoryBytes,
    count: omittedCount,
    reason: "chat_history_budget",
  });
  logDebug(
    `chat.history omitted oversized payloads count=${omittedCount} total=${chatHistoryOmittedEmitCount}`,
  );
  return omittedCount;
}

export function boundInFlightRunSnapshotForChatHistory(params: {
  snapshot: InFlightRunSnapshot | undefined;
  messages: unknown[];
  getMessagesBytes?: () => number;
  maxBytes: number;
}): InFlightRunSnapshot | undefined {
  if (!params.snapshot) {
    return undefined;
  }
  const messagesBytes = params.getMessagesBytes?.() ?? jsonUtf8Bytes(params.messages);
  const snapshotBytes = jsonUtf8Bytes(params.snapshot);
  if (messagesBytes + snapshotBytes <= params.maxBytes) {
    return params.snapshot;
  }
  // Recovery priority is run adoption, authoritative timing, active progress,
  // plan replay, and opportunistic text. Explicit empty projections
  // authoritatively clear stale client state when a richer snapshot cannot fit.
  let bounded: InFlightRunSnapshot = {
    runId: params.snapshot.runId,
    text: "",
    ...(params.snapshot.sessionAbortable ? { sessionAbortable: true } : {}),
    ...(params.snapshot.events ? { events: [] } : {}),
    ...(params.snapshot.plan ? { plan: { steps: [] } } : {}),
  };
  const retainIfWithinBudget = (candidate: InFlightRunSnapshot): boolean => {
    if (!(messagesBytes + jsonUtf8Bytes(candidate) <= params.maxBytes)) {
      return false;
    }
    bounded = candidate;
    return true;
  };

  if (params.snapshot.startedAt !== undefined) {
    retainIfWithinBudget({ ...bounded, startedAt: params.snapshot.startedAt });
  }

  if (params.snapshot.events) {
    const events = params.snapshot.events;
    let start = 0;
    let end = events.length;
    // Try all progress first, then search suffixes instead of serializing each eviction.
    let middle = 0;
    while (start < end) {
      if (retainIfWithinBudget({ ...bounded, events: events.slice(middle) })) {
        end = middle;
      } else {
        start = middle + 1;
      }
      middle = Math.floor((start + end) / 2);
    }
  }

  if (params.snapshot.plan) {
    retainIfWithinBudget({ ...bounded, plan: params.snapshot.plan });
  }

  if (params.snapshot.text) {
    retainIfWithinBudget({ ...bounded, text: params.snapshot.text });
  }
  return bounded;
}
