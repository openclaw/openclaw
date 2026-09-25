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

function isActiveBinding(record: SessionBindingRecord): boolean {
  return record.status === "active";
}

function resolveBindingForRequester(
  requester: ConversationRef,
  bindings: SessionBindingRecord[],
): SessionBindingRecord | null {
  const matchingChannelAccount = bindings.filter((entry) => {
    const conversation = normalizeConversationRef(entry.conversation);
    return (
      conversation.channel === requester.channel && conversation.accountId === requester.accountId
    );
  });
  if (matchingChannelAccount.length === 0) {
    return null;
  }

  const exactConversation = matchingChannelAccount.find(
    (entry) =>
      normalizeConversationRef(entry.conversation).conversationId === requester.conversationId,
  );
  if (exactConversation) {
    return exactConversation;
  }

  if (matchingChannelAccount.length === 1) {
    return matchingChannelAccount[0] ?? null;
  }
  return null;
}

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
        return {
          binding: null,
          mode: "fallback",
          reason: "missing-target-session",
        };
      }

      const activeBindings = (await listBySession(targetSessionKey)).filter(isActiveBinding);
      if (activeBindings.length === 0) {
        return {
          binding: null,
          mode: "fallback",
          reason: "no-active-binding",
        };
      }

      if (!requester) {
        if (failClosed) {
          return {
            binding: null,
            mode: "fallback",
            reason: "missing-requester",
          };
        }
        if (activeBindings.length === 1) {
          return {
            binding: activeBindings[0] ?? null,
            mode: "bound",
            reason: "single-active-binding",
          };
        }
        // Without requester context, multiple active bindings are ambiguous;
        // fallback avoids leaking one session's completion into another chat.
        return {
          binding: null,
          mode: "fallback",
          reason: "ambiguous-without-requester",
        };
      }

      if (!requester.channel || !requester.conversationId) {
        return {
          binding: null,
          mode: "fallback",
          reason: "invalid-requester",
        };
      }

      const fromRequester = resolveBindingForRequester(requester, activeBindings);
      if (fromRequester) {
        return {
          binding: fromRequester,
          mode: "bound",
          reason: "requester-match",
        };
      }

      if (activeBindings.length === 1 && !failClosed) {
        return {
          binding: activeBindings[0] ?? null,
          mode: "bound",
          reason: "single-active-binding-fallback",
        };
      }

      return {
        binding: null,
        mode: "fallback",
        reason: "no-requester-match",
      };
    },
  };
}
