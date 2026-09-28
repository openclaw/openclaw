import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";

export type AssistantMessageExpansionState =
  | { status: "loading"; revision: number }
  | { status: "error"; revision: number }
  | { status: "loaded"; markdown: string; message?: unknown; revision: number };

export type ChatMessageRecovery = {
  messages: ReadonlyMap<string, AssistantMessageExpansionState>;
  revision: number;
  agentId?: string;
};

type PendingInputSource = ChatPendingInputsPage["items"][number];

/** Immutable input payloads keep their source when the Gateway refreshes display objects. */
export function sameSavedInputSource(
  left: PendingInputSource | undefined,
  right: PendingInputSource,
): boolean {
  return (
    left?.id === right.id &&
    left.runId === right.runId &&
    left.acceptedAt === right.acceptedAt &&
    left.state === right.state
  );
}

export function messageRecoveryKey(agentId: string | undefined, messageId: string): string {
  return JSON.stringify([agentId, messageId]);
}

export function resolveSourceMessageId(message: unknown): string | undefined {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  return typeof metadata?.id === "string"
    ? metadata.id
    : typeof record?.messageId === "string"
      ? record.messageId
      : undefined;
}

export function resolveCappedMessageId(message: unknown, role: string): string | undefined {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  const messageId = resolveSourceMessageId(message);
  // Only the Gateway marker proves a display cap; sentinel text can be literal.
  // Pending user inputs share read-only recovery with assistant messages.
  return (normalizeRoleForGrouping(role) === "assistant" ||
    messageId?.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)) &&
    !record?.openclawMessageToolMirror &&
    metadata?.truncated === true
    ? messageId
    : undefined;
}
