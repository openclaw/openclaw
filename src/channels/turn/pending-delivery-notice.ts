import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import {
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { hasActiveDirectPendingFinalDelivery } from "./direct-delivery-custody.js";

/** System-event context key prefix; the turn that consumes the event acknowledges the debt. */
export const PENDING_DELIVERY_CONTEXT_PREFIX = "pending-delivery:";

function describeUncertainDelivery(createdAt: number): string {
  return (
    `Your reply from ${new Date(createdAt).toISOString()} may not have reached this chat: ` +
    "the network failed after it was sent, so delivery could not be confirmed. " +
    "If that reply still matters to the user, restate what they need in this reply; otherwise ignore this."
  );
}

/**
 * Offers owed delivery-uncertainty debt to the turn being admitted on the same route.
 * The agent decides what the user needs to hear; no fixed text reaches the chat.
 * The system-event queue is process-local, so the debt stays owed until a prompt
 * actually consumes the event; a restart or a turn that never builds a prompt re-offers it.
 */
export async function admitPendingDeliveryNotice(
  sessionKey: string,
  storePath: string,
  agentId?: string,
): Promise<void> {
  const resolvedAgentId = agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  await withSessionEntriesFromStoresInWorker(
    [
      {
        agentId: resolvedAgentId,
        storePath,
        sessionKeys: [sessionKey],
        projection: "full",
      },
    ],
    ([read]) => {
      const entry = read?.result.entries[0]?.entry;
      const notice = entry?.pendingDeliveryNotice;
      const context = normalizeDeliveryContext(notice?.context);
      if (
        !entry ||
        !notice ||
        // Stored "unresolved" debt predates this owner; the agent can still settle it.
        notice.state === "acknowledged" ||
        !context?.channel ||
        !context.to ||
        deliveryContextKey(context) !== deliveryContextKey(deliveryContextFromSession(entry)) ||
        hasActiveDirectPendingFinalDelivery(entry.sessionId, notice.intentId)
      ) {
        return;
      }
      read?.assertCurrent();
      // Replacing by context key keeps one pending offer per intent across turns.
      enqueueSystemEvent(describeUncertainDelivery(notice.createdAt), {
        sessionKey: resolveSystemEventQueueKey(sessionKey, resolvedAgentId),
        contextKey: `${PENDING_DELIVERY_CONTEXT_PREFIX}${notice.intentId}`,
        replace: true,
      });
    },
    { ordered: true },
  );
}

/** Settles debt whose offer a prompt has consumed; a newer intent stays owed. */
export async function acknowledgePendingDeliveryNotices(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  intentIds: readonly string[];
}): Promise<void> {
  // System-event context keys are stored lowercase.
  const intentIds = new Set(params.intentIds.map((id) => id.toLowerCase()));
  await updateSessionEntry(
    { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
    (current) => {
      const notice = current.pendingDeliveryNotice;
      return notice &&
        notice.state !== "acknowledged" &&
        intentIds.has(notice.intentId.toLowerCase())
        ? {
            // Retain the terminal fact: queue settlement may replay after this
            // acknowledgment, and one intent must never owe its notice again.
            pendingDeliveryNotice: { ...notice, state: "acknowledged" },
            updatedAt: Date.now(),
          }
        : null;
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}
