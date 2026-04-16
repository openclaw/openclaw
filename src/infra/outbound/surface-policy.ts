// Pure predicate that decides what to do with an outbound message given its
// classification, the target surface, and current session-binding state.
//
// This module intentionally returns a discriminated union; callers MUST handle
// every outcome. The return values are pre-allocated frozen constants so hot
// paths (e.g. ACP parent stream emit) do not allocate a new object per
// decision — see the bound-delivery-router for performance-sensitive uses.

import type { TaskNotifyPolicy } from "../../tasks/task-registry.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { MessageClass } from "./message-class.js";

// Resolved surface target. Reuses DeliveryContext shape but requires channel +
// to so the caller can commit to a routing decision without re-resolving.
export type ResolvedSurfaceTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

export type DeliverySuppressionReason =
  | "class_suppressed_for_surface"
  | "session_not_bound"
  | "operator_only_no_channel"
  | "duplicate_terminal"
  | "backoff_active";

export type DeliveryReroutingReason =
  | "boot_to_operator_channel"
  | "thread_bound_in_thread_only"
  | "cron_to_operator_channel";

export type DeliveryDecision =
  | { outcome: "deliver" }
  | { outcome: "suppress"; reason: DeliverySuppressionReason }
  | {
      outcome: "reroute";
      target: ResolvedSurfaceTarget;
      reason: DeliveryReroutingReason;
    };

export type DeliveryDecisionInput = {
  messageClass: MessageClass;
  surface: DeliveryContext;
  sessionBinding?: {
    threadId?: string | number;
    channel?: string;
  };
  notifyPolicy?: TaskNotifyPolicy;
  operatorChannel?: ResolvedSurfaceTarget;
};

// Pre-allocated constants. `Object.freeze` is defensive but also ensures
// callers cannot mutate the constant and affect later calls.
const DELIVER: DeliveryDecision = Object.freeze({ outcome: "deliver" });
const SUPPRESS_INTERNAL: DeliveryDecision = Object.freeze({
  outcome: "suppress",
  reason: "class_suppressed_for_surface",
});
const SUPPRESS_OPERATOR_NO_CHANNEL: DeliveryDecision = Object.freeze({
  outcome: "suppress",
  reason: "operator_only_no_channel",
});

export function planDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  const { messageClass, notifyPolicy, operatorChannel } = input;

  // CRITICAL: blocked MUST always deliver, even when policy would otherwise
  // suppress. This preserves the Blocked-Child Protocol invariant: the user
  // MUST see any agent request for input.
  if (messageClass === "blocked") {
    return DELIVER;
  }

  // Boot/resume classes are operator-plane signals. Route them to the
  // operator channel when one is configured; otherwise suppress (they do not
  // belong on user-facing surfaces).
  if (messageClass === "boot" || messageClass === "resume") {
    if (operatorChannel) {
      return {
        outcome: "reroute",
        target: operatorChannel,
        reason: "boot_to_operator_channel",
      };
    }
    return SUPPRESS_OPERATOR_NO_CHANNEL;
  }

  // Internal narration is never surfaced on user-facing channels.
  if (messageClass === "internal_narration") {
    return SUPPRESS_INTERNAL;
  }

  // notifyPolicy: "silent" suppresses any non-blocked class. We already
  // short-circuited blocked above, so this is safe.
  if (notifyPolicy === "silent") {
    return SUPPRESS_INTERNAL;
  }

  // notifyPolicy: "operator_only" routes progress/completion traffic to the
  // operator channel when one exists, otherwise suppresses it.
  if (notifyPolicy === "operator_only") {
    if (operatorChannel) {
      return {
        outcome: "reroute",
        target: operatorChannel,
        reason: "cron_to_operator_channel",
      };
    }
    return SUPPRESS_OPERATOR_NO_CHANNEL;
  }

  // Default: the caller's surface is appropriate for this class.
  // Details like in-thread "clean completion" behavior for thread-bound
  // sessions are handled by the caller in Phase 3 of the surface overhaul.
  return DELIVER;
}
