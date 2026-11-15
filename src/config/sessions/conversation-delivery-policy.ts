import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  ConversationDeliveryInputError,
  type ConversationDeliveryInput,
  type ConversationDeliveryRecord,
} from "./conversation-delivery-store.types.js";

export function normalizeConversationDeliveryOperationId(value: string): string {
  const operationId = value.trim();
  if (!operationId) {
    throw new Error("Conversation delivery operation id is required");
  }
  return operationId;
}

export function assertConversationDeliveryInput(
  record: ConversationDeliveryRecord,
  input: ConversationDeliveryInput,
  messageHash = sha256Hex(input.message),
): void {
  if (
    record.conversationRef !== input.conversationRef ||
    record.operationKind !== input.operationKind ||
    record.sourceSessionKey !== (input.sourceSessionKey?.trim() || undefined) ||
    record.messageHash !== messageHash
  ) {
    throw new ConversationDeliveryInputError(
      `Conversation delivery operation was reused with different input: ${record.operationId}`,
    );
  }
}
