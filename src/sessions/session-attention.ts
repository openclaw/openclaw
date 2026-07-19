import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import {
  ackSessionDelivery,
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
} from "../infra/session-delivery-queue.js";
import {
  enqueueSystemEventEntry,
  forgetConsumedSystemEventDeliveryQueueIds,
  peekConsumedSystemEventDeliveryQueueIds,
  peekSystemEventEntries,
  releaseConsumedSystemEventDeliveryQueueIds,
} from "../infra/system-events.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type SessionAttentionDeliveryResult =
  | {
      status: "handoff_accepted";
      sessionKey: string;
      sessionId?: string;
      deliveryQueueId: string;
      duplicate: boolean;
      immediateAdmission: "queued" | "coalesced" | "deferred";
      queuedAt?: number;
    }
  | { status: "missing"; reason: "invalid_session_key" | "session_not_found" };

export async function acknowledgeConsumedSessionAttentionDeliveries(
  sessionKey: string,
): Promise<{ acknowledgedIds: string[]; failed: Array<{ id: string; error: unknown }> }> {
  const acknowledgedIds: string[] = [];
  const failed: Array<{ id: string; error: unknown }> = [];
  for (const id of peekConsumedSystemEventDeliveryQueueIds(sessionKey)) {
    try {
      const entry = await loadPendingSessionDelivery(id);
      if (entry?.kind === "systemEvent" && entry.source?.owner === "durable_wake") {
        const currentSession = loadSessionEntry({ sessionKey, readConsistency: "latest" });
        const {
          acknowledgeDurableSessionWakeConsumption,
          supersedeDurableSessionWakeForGenerationChange,
        } = await import("../durable/session-owner-adapter.js");
        if (
          entry.expectedSessionId !== undefined &&
          currentSession?.sessionId !== entry.expectedSessionId
        ) {
          supersedeDurableSessionWakeForGenerationChange({
            wakeId: entry.source.ref,
            deliveryQueueId: id,
            expectedSessionId: entry.expectedSessionId,
            actualSessionId: currentSession?.sessionId,
          });
        } else {
          acknowledgeDurableSessionWakeConsumption({
            wakeId: entry.source.ref,
            deliveryQueueId: id,
            sessionKey,
            expectedSessionId: entry.expectedSessionId,
          });
        }
      }
      await ackSessionDelivery(id);
      acknowledgedIds.push(id);
    } catch (error) {
      failed.push({ id, error });
    }
  }
  forgetConsumedSystemEventDeliveryQueueIds(sessionKey, acknowledgedIds);
  return { acknowledgedIds, failed };
}

export function releaseConsumedSessionAttentionDeliveries(sessionKey: string): void {
  releaseConsumedSystemEventDeliveryQueueIds(sessionKey);
}

/** Session-owner front door for bounded internal attention notices. */
export async function requestSessionAttentionDelivery(params: {
  sessionKey: string;
  text: string;
  idempotencyKey: string;
  wakeId: string;
  contextKey?: string;
  deliveryContext?: DeliveryContext;
  disableTools?: boolean;
}): Promise<SessionAttentionDeliveryResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { status: "missing", reason: "invalid_session_key" };
  }
  const entry = loadSessionEntry({ sessionKey, readConsistency: "latest" });
  if (!entry) {
    return { status: "missing", reason: "session_not_found" };
  }

  const deliveryQueueId = await enqueueSessionDelivery({
    kind: "systemEvent",
    sessionKey,
    text: params.text,
    ...(entry.sessionId ? { expectedSessionId: entry.sessionId } : {}),
    source: { owner: "durable_wake", ref: params.wakeId },
    deliveryContext: params.deliveryContext,
    idempotencyKey: params.idempotencyKey,
    ...(params.disableTools === true ? { disableTools: true } : {}),
  });
  const queued = enqueueSystemEventEntry(params.text, {
    sessionKey,
    contextKey: params.contextKey ?? params.idempotencyKey,
    deliveryContext: params.deliveryContext,
    deliveryQueueId,
    disableTools: params.disableTools,
  });
  const admitted =
    queued ??
    peekSystemEventEntries(sessionKey).find((event) =>
      event.deliveryQueueIds?.includes(deliveryQueueId),
    );
  const immediateAdmission = queued ? "queued" : admitted ? "coalesced" : "deferred";
  requestHeartbeat({
    source: "other",
    intent: "immediate",
    reason: "durable-attention",
    sessionKey,
  });
  return {
    status: "handoff_accepted",
    sessionKey,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    deliveryQueueId,
    duplicate: immediateAdmission === "coalesced",
    immediateAdmission,
    ...(admitted ? { queuedAt: admitted.ts } : {}),
  };
}
