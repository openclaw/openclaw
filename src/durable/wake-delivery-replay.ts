import type {
  DurableRuntimeStore,
  DurableWake,
  DurableWakeDeliveryAttempt,
  DurableWakeDeliveryAttemptStatus,
  DurableWakeTargetKind,
} from "./types.js";

export type DurableWakeDeliveryHookResult = {
  status: Extract<
    DurableWakeDeliveryAttemptStatus,
    "attempted" | "delivered" | "failed" | "unknown"
  >;
  evidence?: Record<string, unknown>;
  error?: string;
};

export type DurableWakeDeliveryHook = (input: {
  wake: DurableWake;
  attempt: DurableWakeDeliveryAttempt;
}) => DurableWakeDeliveryHookResult | Promise<DurableWakeDeliveryHookResult>;

export type DurableWakeDeliveryReplayResult = {
  replayPassId: string;
  scanned: number;
  recorded: number;
  deduped: number;
  delivered: number;
  failed: number;
  unknown: number;
  pending: number;
  attempts: DurableWakeDeliveryAttempt[];
};

function routeForWake(wake: DurableWake): {
  routeKind: DurableWakeTargetKind;
  routeRef: string;
} {
  if (wake.reportRouteRef) {
    return {
      routeKind: "channel_route",
      routeRef: wake.reportRouteRef,
    };
  }
  if (wake.targetKind && wake.targetRef) {
    return {
      routeKind: wake.targetKind,
      routeRef: wake.targetRef,
    };
  }
  if (
    wake.targetResolutionStatus === "ambiguous" ||
    wake.targetResolutionStatus === "missing" ||
    wake.targetResolutionStatus === "unauthorized"
  ) {
    return {
      routeKind: "operator",
      routeRef: "operator",
    };
  }
  return {
    routeKind: "inspect_only",
    routeRef: `wake:${wake.wakeId}`,
  };
}

function attemptDedupeKey(
  wake: DurableWake,
  route: { routeKind: string; routeRef: string },
): string {
  return `wake-delivery:v1:${wake.wakeId}:${route.routeKind}:${route.routeRef}`;
}

function timestampForStatus(
  status: DurableWakeDeliveryAttemptStatus,
  now: number,
): {
  attemptedAt?: number;
  deliveredAt?: number;
  failedAt?: number;
  unknownAt?: number;
} {
  return {
    ...(status === "attempted" ||
    status === "delivered" ||
    status === "failed" ||
    status === "unknown"
      ? { attemptedAt: now }
      : {}),
    ...(status === "delivered" ? { deliveredAt: now } : {}),
    ...(status === "failed" ? { failedAt: now } : {}),
    ...(status === "unknown" ? { unknownAt: now } : {}),
  };
}

function updateWakeOutcome(params: {
  store: DurableRuntimeStore;
  wake: DurableWake;
  status: DurableWakeDeliveryAttemptStatus;
  error?: string;
  now: number;
}): void {
  if (params.status === "delivered") {
    params.store.updateDurableWake({
      wakeId: params.wake.wakeId,
      status: "delivered",
      attemptCount: params.wake.attemptCount + 1,
      lastAttemptAt: params.now,
      now: params.now,
    });
  }
  if (params.status === "failed") {
    params.store.updateDurableWake({
      wakeId: params.wake.wakeId,
      status: "failed",
      attemptCount: params.wake.attemptCount + 1,
      lastAttemptAt: params.now,
      failedReason: params.error ?? "delivery_failed",
      now: params.now,
    });
  }
}

/**
 * Crash recovery contract for the delivery boundary:
 * - pending means the durable attempt was recorded before any delivery side effect;
 *   replay may safely reclaim the same attempt id and call the hook.
 * - attempted means the hook crossed its delivery side-effect boundary but did not
 *   record a terminal outcome before the process stopped; replay must pass the
 *   same attempt id back to the hook so the delivery implementation can confirm
 *   or complete idempotently instead of silently dropping the wake.
 * - delivered/failed/unknown are terminal ledger outcomes and remain deduped.
 */
function isReclaimableAttempt(attempt: DurableWakeDeliveryAttempt): boolean {
  return attempt.status === "pending" || attempt.status === "attempted";
}

async function applyDeliveryHook(params: {
  store: DurableRuntimeStore;
  wake: DurableWake;
  attempt: DurableWakeDeliveryAttempt;
  deliveryHook: DurableWakeDeliveryHook;
  replayPassId: string;
  now?: number;
}): Promise<DurableWakeDeliveryAttempt> {
  try {
    const hookResult = await params.deliveryHook({
      wake: params.wake,
      attempt: params.attempt,
    });
    const outcomeAt = params.now ?? Date.now();
    const attempt =
      params.store.updateWakeDeliveryAttempt({
        deliveryAttemptId: params.attempt.deliveryAttemptId,
        status: hookResult.status,
        ...(hookResult.evidence ? { evidence: hookResult.evidence } : {}),
        ...(hookResult.error ? { error: hookResult.error } : {}),
        ...timestampForStatus(hookResult.status, outcomeAt),
        metadata: {
          deliveryContract: "durable_wake_delivery_replay_v1",
          replayPassId: params.replayPassId,
        },
        now: outcomeAt,
      }) ?? params.attempt;
    updateWakeOutcome({
      store: params.store,
      wake: params.wake,
      status: hookResult.status,
      ...(hookResult.error ? { error: hookResult.error } : {}),
      now: outcomeAt,
    });
    return attempt;
  } catch (err) {
    const failedAt = params.now ?? Date.now();
    const error = err instanceof Error ? err.message : String(err);
    const attempt =
      params.store.updateWakeDeliveryAttempt({
        deliveryAttemptId: params.attempt.deliveryAttemptId,
        status: "failed",
        evidence: {
          kind: "wake_delivery_hook_error",
        },
        error,
        attemptedAt: failedAt,
        failedAt,
        metadata: {
          deliveryContract: "durable_wake_delivery_replay_v1",
          replayPassId: params.replayPassId,
        },
        now: failedAt,
      }) ?? params.attempt;
    updateWakeOutcome({
      store: params.store,
      wake: params.wake,
      status: "failed",
      error,
      now: failedAt,
    });
    return attempt;
  }
}

export async function replayDurableWakeDeliveryAttempts(params: {
  store: DurableRuntimeStore;
  replayPassId?: string;
  limit?: number;
  now?: number;
  deliveryHook?: DurableWakeDeliveryHook;
}): Promise<DurableWakeDeliveryReplayResult> {
  const now = params.now ?? Date.now();
  const replayPassId = params.replayPassId ?? `wake-delivery-replay:${now}`;
  const wakes = params.store.listDurableWakes({
    status: "pending",
    limit: params.limit,
  });
  const result: DurableWakeDeliveryReplayResult = {
    replayPassId,
    scanned: wakes.length,
    recorded: 0,
    deduped: 0,
    delivered: 0,
    failed: 0,
    unknown: 0,
    pending: 0,
    attempts: [],
  };

  for (const wake of wakes) {
    const route = routeForWake(wake);
    const dedupeKey = attemptDedupeKey(wake, route);
    const existing = params.store.listWakeDeliveryAttempts({
      wakeId: wake.wakeId,
      dedupeKey,
      limit: 1,
    })[0];
    if (existing && !isReclaimableAttempt(existing)) {
      result.deduped += 1;
      result.attempts.push(existing);
      continue;
    }

    let attempt =
      existing ??
      params.store.recordWakeDeliveryAttempt({
        wakeId: wake.wakeId,
        dedupeKey,
        replayPassId,
        ...(wake.targetKind ? { targetKind: wake.targetKind } : {}),
        ...(wake.targetRef ? { targetRef: wake.targetRef } : {}),
        routeKind: route.routeKind,
        routeRef: route.routeRef,
        status: "pending",
        evidence: {
          kind: "wake_delivery_scheduled",
          wakeId: wake.wakeId,
          wakeReason: wake.reason,
          targetResolutionStatus: wake.targetResolutionStatus,
        },
        metadata: {
          deliveryContract: "durable_wake_delivery_replay_v1",
          replayPassId,
        },
        now,
      });
    if (!existing) {
      result.recorded += 1;
    }

    if (params.deliveryHook) {
      attempt = await applyDeliveryHook({
        store: params.store,
        wake,
        attempt,
        deliveryHook: params.deliveryHook,
        replayPassId,
        now: params.now,
      });
    }

    if (attempt.status === "delivered") {
      result.delivered += 1;
    } else if (attempt.status === "failed") {
      result.failed += 1;
    } else if (attempt.status === "unknown") {
      result.unknown += 1;
    } else {
      result.pending += 1;
    }
    result.attempts.push(attempt);
  }

  return result;
}
