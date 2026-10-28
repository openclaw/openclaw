import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { getGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime-context.js";
import { findDeliveryIntentOwner } from "../../infra/outbound/delivery-queue-storage.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import {
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { hasActiveDirectPendingFinalDelivery } from "./direct-delivery-custody.js";

const PENDING_DELIVERY_NOTICE =
  "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";

export async function deliverPendingDeliveryNotice(
  sessionKey: string,
  storePath: string,
  agentId: string | undefined,
): Promise<void> {
  const resolvedAgentId = agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const pending = await withSessionEntriesFromStoresInWorker(
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
      const runtime = getGatewayRecoveryRuntime();
      if (
        !entry ||
        !runtime ||
        !notice ||
        notice.state !== "owed" ||
        !context?.channel ||
        !context.to ||
        deliveryContextKey(context) !== deliveryContextKey(deliveryContextFromSession(entry)) ||
        hasActiveDirectPendingFinalDelivery(entry.sessionId, notice.intentId)
      ) {
        return undefined;
      }
      // Start under the reader's FIFO admission: settlement cannot invalidate owed debt first.
      read?.assertCurrent();
      const idempotencyKey = `main-session-restart-recovery:pending-final:${notice.intentId}`;
      const delivery = runtime
        .sendRecoveryNotice({
          channel: context.channel,
          to: context.to,
          accountId: context.accountId,
          threadId: context.threadId,
          text: PENDING_DELIVERY_NOTICE,
          idempotencyKey,
          generation: {
            agentId: resolvedAgentId,
            storePath,
            sessionKey,
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision ?? null,
          },
          provenance: { kind: "recovery-notice", noticeId: idempotencyKey },
        })
        .catch(() => undefined);
      return { entry, notice, idempotencyKey, delivery };
    },
    { ordered: true },
  );
  if (!pending) {
    return;
  }
  const { entry, notice, idempotencyKey } = pending;
  const outcome = await pending.delivery;
  let delivered: boolean;
  if (outcome) {
    delivered = !outcome.suppressed;
  } else {
    const owner = await findDeliveryIntentOwner(idempotencyKey);
    if (owner?.status !== "completed" && owner?.status !== "failed") {
      return;
    }
    delivered = owner.status === "completed";
  }
  await updateSessionEntry(
    { agentId: resolvedAgentId, sessionKey, storePath },
    (current) =>
      current.sessionId === entry.sessionId &&
      (current.lifecycleRevision ?? null) === (entry.lifecycleRevision ?? null) &&
      current.pendingDeliveryNotice?.intentId === notice.intentId &&
      current.pendingDeliveryNotice.state !== "acknowledged"
        ? {
            // Retain the terminal fact: queue settlement may replay after this
            // acknowledgment, and one intent must never owe its notice again.
            pendingDeliveryNotice: {
              ...current.pendingDeliveryNotice,
              state: delivered ? "acknowledged" : "unresolved",
            },
            updatedAt: Date.now(),
          }
        : null,
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}
