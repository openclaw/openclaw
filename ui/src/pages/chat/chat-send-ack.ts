// Leaf contract for chat.send acknowledgment shapes.
// Kept import-free of chat-page modules so lifecycle and history layers
// can consume ack types without forming import cycles.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type ChatSendAckStatus = "started" | "in_flight" | "ok" | "timeout" | "error";

export type ChatSendAck = {
  runId: string;
  status: ChatSendAckStatus;
  stopReason?: "restart";
  messageSeq?: number;
};

export function normalizeChatSendAckStatus(status: unknown): ChatSendAckStatus {
  return status === "in_flight" || status === "ok" || status === "timeout" || status === "error"
    ? status
    : "started";
}

export function normalizeChatSendAck(payload: unknown, fallbackRunId: string): ChatSendAck {
  if (!payload || typeof payload !== "object") {
    return { runId: fallbackRunId, status: "started" };
  }
  const record = payload as Record<string, unknown>;
  const runId = normalizeOptionalString(record.runId) ?? fallbackRunId;
  const messageSeq = asPositiveSafeInteger(record.messageSeq);
  return {
    runId,
    status: normalizeChatSendAckStatus(record.status),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
    ...(record.stopReason === "restart" ? { stopReason: "restart" as const } : {}),
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

export function formatTerminalChatSendAckError(
  ack: TerminalFailureChatSendAck,
  context: "chat" | "detached",
): string {
  return ack.status === "error"
    ? "Chat failed before the run started; try again."
    : context === "detached"
      ? "The active run ended before the detached message was accepted."
      : "The run ended before the message was accepted.";
}
