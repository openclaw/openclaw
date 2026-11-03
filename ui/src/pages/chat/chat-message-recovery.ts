import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import type { ChatDisplayFacts } from "../../lib/chat/row-display-facts.ts";

export type AssistantMessageExpansionState =
  | { status: "loading"; revision: number }
  | { status: "error"; revision: number }
  | { status: "loaded"; markdown: string; message?: unknown; revision: number };

export type ChatMessageRecovery = {
  messages: ReadonlyMap<string, AssistantMessageExpansionState>;
  revision: number;
  agentId?: string;
  displayFacts?: ChatDisplayFacts;
  canFetchFullMessage?: boolean;
};

export function resolveFullMessageRecovery(
  message: unknown,
  role: string,
  options: {
    canFetchFullMessage?: boolean;
    displayFacts?: ChatDisplayFacts;
    getAssistantMessageExpansion?: (
      messageId: string,
    ) => AssistantMessageExpansionState | undefined;
  },
) {
  const messageId = resolveCappedMessageId(message, role);
  const cached = messageId
    ? options.displayFacts?.forRow(messageId)?.read()?.facts?.recoveredMessage
    : undefined;
  const retained: AssistantMessageExpansionState | undefined =
    cached && cached.source === extractTextCached(message)
      ? {
          status: "loaded",
          markdown: extractTextCached(cached.message) ?? "",
          message: cached.message,
          revision: 0,
        }
      : undefined;
  const live = messageId ? options.getAssistantMessageExpansion?.(messageId) : undefined;
  return messageId && (options.canFetchFullMessage || retained)
    ? { messageId, state: live?.status === "loaded" ? live : (retained ?? live) }
    : undefined;
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
