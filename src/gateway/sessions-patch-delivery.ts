// Delivery and routing mutations for sessions.patch.
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  stripThreadFromSessionRoute,
  stripThreadIdFromDeliveryContext,
  stripThreadIdFromOrigin,
} from "../auto-reply/reply/session-route-reset.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { normalizeSendPolicy } from "../sessions/send-policy.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "../utils/delivery-context.shared.js";

/** Applies public delivery/routing patch fields; returns an error message on invalid input. */
export function applySessionsPatchDelivery(params: {
  next: SessionEntry;
  patch: SessionsPatchParams;
}): string | undefined {
  const { next, patch } = params;

  if ("sendPolicy" in patch) {
    const raw = patch.sendPolicy;
    if (raw === null) {
      delete next.sendPolicy;
    } else if (raw !== undefined) {
      const normalized = normalizeSendPolicy(raw);
      if (!normalized) {
        return 'invalid sendPolicy (use "allow"|"deny")';
      }
      next.sendPolicy = normalized;
    }
  }

  if ("groupActivation" in patch) {
    const raw = patch.groupActivation;
    if (raw === null) {
      delete next.groupActivation;
    } else if (raw !== undefined) {
      const normalized = normalizeGroupActivation(raw);
      if (!normalized) {
        return 'invalid groupActivation (use "mention"|"always")';
      }
      next.groupActivation = normalized;
    }
  }

  // Null-only public repair for stale delivery threads. Setting a new thread
  // via patch is not a sessions.patch contract; /new already strips internally.
  // Without this, DMs keep sending message_thread_id until the store is edited.
  if (patch.threadId === null) {
    next.delivery = normalizeSessionDeliveryState({
      route: stripThreadFromSessionRoute(sessionDeliveryRoute(next)),
      context: stripThreadIdFromDeliveryContext(deliveryContextFromSession(next)),
      origin: stripThreadIdFromOrigin(sessionDeliveryOrigin(next)),
    });
  }

  return undefined;
}
