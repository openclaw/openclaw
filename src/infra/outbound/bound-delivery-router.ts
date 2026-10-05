// Bound delivery router maps task-completion delivery back to active
// conversation bindings, failing closed when requester context is ambiguous.
import { normalizeConversationRef } from "./session-binding-normalization.js";
import {
  listSessionBindingsBySessionAsync,
  type ConversationRef,
  type SessionBindingRecord,
} from "./session-binding-service.js";

/** Resolved session binding or the fallback reason used by delivery callers. */
type BoundDeliveryRouterResult = {
  binding: SessionBindingRecord | null;
  mode: "bound" | "fallback";
  reason: string;
};

function resolveBindingForRequester(
  requester: ConversationRef,
  bindings: SessionBindingRecord[],
): SessionBindingRecord | null {
  let exactBinding: SessionBindingRecord | null = null;
  let matchingBinding: SessionBindingRecord | null = null;
  let matchingCount = 0;
  for (const entry of bindings) {
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

const fallbackDestination = (reason: string): BoundDeliveryRouterResult => ({
  binding: null,
  mode: "fallback",
  reason,
});

/** Resolves task-completion delivery through active bindings and requester identity. */
export async function resolveBoundDeliveryDestination(input: {
  targetSessionKey: string;
  requester?: ConversationRef;
}): Promise<BoundDeliveryRouterResult> {
  const targetSessionKey = input.targetSessionKey.trim();
  const requester = input.requester ? normalizeConversationRef(input.requester) : undefined;
  if (!targetSessionKey) {
    return fallbackDestination("missing-target-session");
  }

  const activeBindings = (await listSessionBindingsBySessionAsync(targetSessionKey)).filter(
    (record) => record.status === "active",
  );
  if (activeBindings.length === 0) {
    return fallbackDestination("no-active-binding");
  }
  if (!requester) {
    return fallbackDestination("missing-requester");
  }
  if (!requester.channel || !requester.conversationId) {
    return fallbackDestination("invalid-requester");
  }

  const binding = resolveBindingForRequester(requester, activeBindings);
  return binding
    ? { binding, mode: "bound", reason: "requester-match" }
    : fallbackDestination("no-requester-match");
}
