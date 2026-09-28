// Bound delivery router maps task-completion delivery back to active
// conversation bindings, failing closed when requester context is ambiguous.
import { normalizeConversationRef } from "./session-binding-normalization.js";
import {
  listSessionBindingsBySessionAsync,
  type ConversationRef,
  type SessionBindingRecord,
} from "./session-binding-service.js";

/** Session-bound delivery lookup input for routing task completion messages. */
type BoundDeliveryRouterInput = {
  eventKind: "task_completion";
  targetSessionKey: string;
  requester?: ConversationRef;
  failClosed: boolean;
};

/** Resolved session binding or the fallback reason used by delivery callers. */
type BoundDeliveryRouterResult = {
  binding: SessionBindingRecord | null;
  mode: "bound" | "fallback";
  reason: string;
};

/** Router facade that maps a target session/requester pair to a bound conversation. */
type BoundDeliveryRouter = {
  resolveDestination: (input: BoundDeliveryRouterInput) => Promise<BoundDeliveryRouterResult>;
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

const boundDestination = (
  binding: SessionBindingRecord | null,
  reason: string,
): BoundDeliveryRouterResult => ({ binding, mode: "bound", reason });

/** Creates a router that resolves task-completion delivery through active session bindings. */
export function createBoundDeliveryRouter(
  listBySession: (
    targetSessionKey: string,
  ) => Promise<SessionBindingRecord[]> = listSessionBindingsBySessionAsync,
): BoundDeliveryRouter {
  return {
    resolveDestination: async (input) => {
      const targetSessionKey = input.targetSessionKey.trim();
      const requester = input.requester ? normalizeConversationRef(input.requester) : undefined;
      const failClosed = input.failClosed;
      if (!targetSessionKey) {
        return fallbackDestination("missing-target-session");
      }

      const activeBindings = (await listBySession(targetSessionKey)).filter(
        (record) => record.status === "active",
      );
      if (activeBindings.length === 0) {
        return fallbackDestination("no-active-binding");
      }

      if (!requester) {
        if (failClosed) {
          return fallbackDestination("missing-requester");
        }
        if (activeBindings.length === 1) {
          return boundDestination(activeBindings[0] ?? null, "single-active-binding");
        }
        // Without requester context, multiple active bindings are ambiguous;
        // fallback avoids leaking one session's completion into another chat.
        return fallbackDestination("ambiguous-without-requester");
      }

      if (!requester.channel || !requester.conversationId) {
        return fallbackDestination("invalid-requester");
      }

      const fromRequester = resolveBindingForRequester(requester, activeBindings);
      if (fromRequester) {
        return boundDestination(fromRequester, "requester-match");
      }

      if (activeBindings.length === 1 && !failClosed) {
        return boundDestination(activeBindings[0] ?? null, "single-active-binding-fallback");
      }

      return fallbackDestination("no-requester-match");
    },
  };
}
