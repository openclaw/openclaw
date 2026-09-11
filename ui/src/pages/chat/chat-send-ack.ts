// Leaf contract for chat.send acknowledgment shapes and timing records.
// Kept import-free of chat-page modules so lifecycle and history layers
// can consume ack types without forming import cycles.
import { asNonNegativeFiniteNumber as normalizeAckTimingValue } from "@openclaw/normalization-core/number-coercion";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";

// "submitted" is a live local session: the Gateway relayed the input to the
// device and no Gateway run exists, so no `chat` events follow this runId.
type ChatSendAckStatus = "started" | "in_flight" | "ok" | "timeout" | "error" | "submitted";

// Lead follow-up: replace with the gateway-protocol export once the chat.send ack schema carries it.
type ChatSendAckLocalInput = { inputId: string; state: "accepted" };

type ChatSendAckServerTiming = {
  receivedToAckMs?: number;
  loadSessionMs?: number;
  prepareAttachmentsMs?: number;
};

export type ChatSendAck = {
  runId: string;
  status: ChatSendAckStatus;
  stopReason?: "restart";
  messageSeq?: number;
  serverTiming?: ChatSendAckServerTiming;
  localInput?: ChatSendAckLocalInput;
};

function normalizeChatSendAckLocalInput(value: unknown): ChatSendAckLocalInput | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inputId = typeof record.inputId === "string" ? record.inputId.trim() : "";
  return inputId && record.state === "accepted" ? { inputId, state: "accepted" } : undefined;
}

function normalizeChatSendAckServerTiming(value: unknown): ChatSendAckServerTiming | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const receivedToAckMs = normalizeAckTimingValue(record.receivedToAckMs);
  const loadSessionMs = normalizeAckTimingValue(record.loadSessionMs);
  const prepareAttachmentsMs = normalizeAckTimingValue(record.prepareAttachmentsMs);
  const timing: ChatSendAckServerTiming = {
    ...(receivedToAckMs !== undefined ? { receivedToAckMs } : {}),
    ...(loadSessionMs !== undefined ? { loadSessionMs } : {}),
    ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
  };
  return Object.keys(timing).length > 0 ? timing : undefined;
}

function normalizeChatSendAckStatus(
  status: unknown,
  localInput: ChatSendAckLocalInput | undefined,
): ChatSendAckStatus {
  if (status === "in_flight" || status === "ok" || status === "timeout" || status === "error") {
    return status;
  }
  if (status === "submitted") {
    // A submitted ack without its input receipt has nothing to track; treat it
    // as a completed Gateway-side hand-off so history reload owns display.
    return localInput ? "submitted" : "ok";
  }
  return "started";
}

export function normalizeChatSendAck(payload: unknown, fallbackRunId: string): ChatSendAck {
  if (!payload || typeof payload !== "object") {
    return { runId: fallbackRunId, status: "started" };
  }
  // SAFETY: payload is a non-null object per the guard above; fields are read defensively.
  const record = payload as Record<string, unknown>;
  const runId =
    typeof record.runId === "string" && record.runId.trim() ? record.runId.trim() : fallbackRunId;
  const serverTiming = normalizeChatSendAckServerTiming(record.serverTiming);
  const messageSeq =
    typeof record.messageSeq === "number" &&
    Number.isSafeInteger(record.messageSeq) &&
    record.messageSeq > 0
      ? record.messageSeq
      : undefined;
  const localInput =
    record.status === "submitted" ? normalizeChatSendAckLocalInput(record.localInput) : undefined;
  return {
    runId,
    status: normalizeChatSendAckStatus(record.status, localInput),
    ...(serverTiming ? { serverTiming } : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
    ...(record.stopReason === "restart" ? { stopReason: "restart" as const } : {}),
    ...(localInput ? { localInput } : {}),
  };
}

export type TerminalFailureChatSendAck = ChatSendAck & { status: "timeout" | "error" };

// ChatSendAck's status is a union field, not a discriminant across object
// types; callers need this predicate to narrow the whole ack object.
export function isTerminalFailureChatSendAck(
  ack: ChatSendAck | null,
): ack is TerminalFailureChatSendAck {
  return ack?.status === "timeout" || ack?.status === "error";
}

export type ChatSendTimingEntry = {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  sendAttempts: number;
  sendState?: ChatQueueItem["sendState"];
  submittedAtMs: number;
  requestStartedAtMs?: number;
  ackAtMs?: number;
  ackStatus?: ChatSendAckStatus;
  firstAssistantVisibleRecorded?: boolean;
};
