import {
  enqueueSessionDelivery,
  type QueuedSessionDeliveryPayload,
} from "../infra/session-delivery-queue.js";
import type { DurableWake, DurableWakeDeliveryAttempt } from "./types.js";
import type {
  DurableWakeDeliveryHook,
  DurableWakeDeliveryHookResult,
} from "./wake-delivery-replay.js";

export type EnqueueDurableWakeSessionDelivery = (
  payload: QueuedSessionDeliveryPayload,
  stateDir?: string,
) => Promise<string>;

export type DurableWakeSessionDeliveryHookOptions = {
  stateDir?: string;
  enqueue?: EnqueueDurableWakeSessionDelivery;
};

function resolvedSessionKey(wake: DurableWake): string | undefined {
  if (wake.targetResolutionStatus !== "resolved") {
    return undefined;
  }
  if (wake.targetKind === "agent_session" && wake.targetRef?.trim()) {
    return wake.targetRef.trim();
  }
  if (wake.ownerKind === "agent_session" && wake.ownerRef?.trim()) {
    return wake.ownerRef.trim();
  }
  if (wake.parentSessionKey?.trim()) {
    return wake.parentSessionKey.trim();
  }
  return undefined;
}

function wakeDeliveryText(wake: DurableWake, attempt: DurableWakeDeliveryAttempt): string {
  const parts = [
    "Durable wake obligation recorded.",
    `wakeId=${wake.wakeId}`,
    `reason=${wake.reason}`,
    `deliveryAttemptId=${attempt.deliveryAttemptId}`,
  ];
  if (wake.sourceRunId) {
    parts.push(`sourceRunId=${wake.sourceRunId}`);
  }
  if (wake.factsRef) {
    parts.push(`factsRef=${wake.factsRef}`);
  }
  parts.push(`inspect=openclaw durable wake ${wake.wakeId}`);
  return parts.join(" ");
}

function unknownResult(
  wake: DurableWake,
  attempt: DurableWakeDeliveryAttempt,
  reason: string,
): DurableWakeDeliveryHookResult {
  return {
    status: "unknown",
    evidence: {
      kind: "wake_internal_session_delivery_not_enqueued",
      reason,
      wakeId: wake.wakeId,
      deliveryAttemptId: attempt.deliveryAttemptId,
      targetResolutionStatus: wake.targetResolutionStatus,
      targetKind: wake.targetKind,
      targetRef: wake.targetRef,
      ownerKind: wake.ownerKind,
      ownerRef: wake.ownerRef,
      routeKind: attempt.routeKind,
      routeRef: attempt.routeRef,
      internalDelivery: "session_delivery_queue",
      noExternalSend: true,
    },
  };
}

export function createDurableWakeSessionDeliveryHook(
  options: DurableWakeSessionDeliveryHookOptions = {},
): DurableWakeDeliveryHook {
  const enqueue = options.enqueue ?? enqueueSessionDelivery;
  return async ({ wake, attempt }) => {
    const sessionKey = resolvedSessionKey(wake);
    if (!sessionKey) {
      return unknownResult(wake, attempt, "no_resolved_agent_session_target");
    }

    const idempotencyKey = `durable-wake-session-delivery:v1:${wake.wakeId}:${attempt.dedupeKey}`;
    const queueId = await enqueue(
      {
        kind: "systemEvent",
        sessionKey,
        text: wakeDeliveryText(wake, attempt),
        idempotencyKey,
      },
      options.stateDir,
    );

    return {
      status: "delivered",
      evidence: {
        kind: "wake_internal_session_delivery_enqueued",
        wakeId: wake.wakeId,
        deliveryAttemptId: attempt.deliveryAttemptId,
        queueId,
        sessionKey,
        routeKind: attempt.routeKind,
        routeRef: attempt.routeRef,
        reportRouteRef: wake.reportRouteRef,
        internalDelivery: "session_delivery_queue",
        noExternalSend: true,
      },
    };
  };
}
