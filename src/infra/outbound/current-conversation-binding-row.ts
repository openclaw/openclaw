import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

export function currentConversationBindingRow(
  record: SessionBindingRecord,
  conversation: ConversationRef,
  bindingKey: string,
) {
  return {
    binding_key: bindingKey,
    binding_id: record.bindingId,
    target_session_key: record.targetSessionKey,
    channel: conversation.channel,
    account_id: conversation.accountId,
    conversation_kind: "current",
    parent_conversation_id: conversation.parentConversationId ?? null,
    conversation_id: conversation.conversationId,
    target_kind: record.targetKind,
    status: record.status,
    bound_at: record.boundAt,
    expires_at: record.expiresAt ?? null,
    metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
    record_json: JSON.stringify(record),
    updated_at: Date.now(),
  };
}
