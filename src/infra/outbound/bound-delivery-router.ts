// Bound delivery router maps task-completion delivery back to active
// conversation bindings, failing closed when requester context is ambiguous.
import { normalizeConversationRef } from "./session-binding-normalization.js";
import {
  listSessionBindingsBySessionAsync,
  type ConversationRef,
  type SessionBindingRecord,
} from "./session-binding-service.js";

/** Resolves task-completion delivery only within the requester's conversation scope. */
export async function resolveBoundDeliveryDestination(input: {
  targetSessionKey: string;
  requester?: ConversationRef;
}): Promise<SessionBindingRecord | null> {
  const targetSessionKey = input.targetSessionKey.trim();
  const requester = input.requester ? normalizeConversationRef(input.requester) : undefined;
  if (!targetSessionKey) {
    return null;
  }
  const activeBindings = (await listSessionBindingsBySessionAsync(targetSessionKey)).filter(
    (record) => record.status === "active",
  );
  if (!requester?.channel || !requester.conversationId) {
    return null;
  }
  let exactBinding: SessionBindingRecord | null = null;
  let matchingBinding: SessionBindingRecord | null = null;
  let matchingCount = 0;
  for (const entry of activeBindings) {
    const conversation = normalizeConversationRef(entry.conversation);
    if (
      conversation.channel !== requester.channel ||
      conversation.accountId !== requester.accountId
    ) {
      continue;
    }
    if (conversation.conversationId === requester.conversationId) {
      exactBinding ??= entry;
    }
    matchingBinding = entry;
    matchingCount += 1;
  }
  return exactBinding ?? (matchingCount === 1 ? matchingBinding : null);
}
