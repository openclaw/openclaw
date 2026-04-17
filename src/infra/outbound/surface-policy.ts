// Pure predicate that decides what to do with an outbound message given its
// classification, the target surface, and current session-binding state.
//
// This module intentionally returns a discriminated union; callers MUST handle
// every outcome. The return values are pre-allocated frozen constants so hot
// paths (e.g. ACP parent stream emit) do not allocate a new object per
// decision — see the bound-delivery-router for performance-sensitive uses.
//
// Phase 4 REWORK (origin-respect routing): the prior policy rerouted boot /
// resume and `notifyPolicy === "operator_only"` traffic into a configured
// `channels.operator` bucket. That was the wrong model — it collapsed all
// noise into a single bucket regardless of where a message originated. The
// correct principle is "every message lands on the surface that originated
// it; if there is no genuine origin, suppress silently." This file keeps
// `messageClass` tagging (Phase 3 sanitizer depends on it) and the
// suppress-when-no-origin branch, but no longer reroutes to an operator
// bucket.

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
  | "no_origin"
  | "duplicate_terminal"
  | "backoff_active";

export type DeliveryDecision =
  | { outcome: "deliver" }
  | { outcome: "suppress"; reason: DeliverySuppressionReason };

export type DeliveryDecisionInput = {
  messageClass: MessageClass;
  surface: DeliveryContext;
  sessionBinding?: {
    threadId?: string | number;
    channel?: string;
  };
  notifyPolicy?: TaskNotifyPolicy;
};

// Pre-allocated constants. `Object.freeze` is defensive but also ensures
// callers cannot mutate the constant and affect later calls.
const DELIVER: DeliveryDecision = Object.freeze({ outcome: "deliver" });
const SUPPRESS_INTERNAL: DeliveryDecision = Object.freeze({
  outcome: "suppress",
  reason: "class_suppressed_for_surface",
});
const SUPPRESS_NO_ORIGIN: DeliveryDecision = Object.freeze({
  outcome: "suppress",
  reason: "no_origin",
});

function hasValidOrigin(surface: DeliveryContext): boolean {
  const channel = typeof surface.channel === "string" ? surface.channel.trim() : "";
  const to = typeof surface.to === "string" ? surface.to.trim() : "";
  return channel.length > 0 && to.length > 0;
}

export function planDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  const { messageClass, notifyPolicy, surface } = input;

  // CRITICAL: blocked MUST always deliver, even when policy would otherwise
  // suppress. This preserves the Blocked-Child Protocol invariant: the user
  // MUST see any agent request for input.
  if (messageClass === "blocked") {
    return DELIVER;
  }

  // Boot/resume classes are operator-plane signals. They must respect the
  // surface that originated them (e.g. the sentinel's own stored target, or
  // the boot-session's bound surface). When the caller truly has no origin,
  // suppress silently rather than synthesizing a destination.
  if (messageClass === "boot" || messageClass === "resume") {
    if (hasValidOrigin(surface)) {
      return DELIVER;
    }
    return SUPPRESS_NO_ORIGIN;
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

  // Anything with genuinely no origin is suppressed — every message must land
  // on the surface that created it.
  if (!hasValidOrigin(surface)) {
    return SUPPRESS_NO_ORIGIN;
  }

  // Default: the caller's surface is appropriate for this class. Details like
  // in-thread "clean completion" behavior for thread-bound sessions are
  // handled by the caller in Phase 3 of the surface overhaul.
  return DELIVER;
}
