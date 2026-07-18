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

const DEFAULT_WAKE_DELIVERY_CLAIM_TTL_MS = 30_000;

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

function finalizeAttemptAndWakeOutcome(params: {
  store: DurableRuntimeStore;
  wake: DurableWake;
  deliveryAttemptId: string;
  status: DurableWakeDeliveryAttemptStatus;
  expectedClaimedBy?: string;
  evidence?: Record<string, unknown>;
  error?: string;
  attemptedAt: number;
  metadata: Record<string, unknown>;
  now: number;
}): DurableWakeDeliveryAttempt | undefined {
  if (params.status === "delivered") {
    return params.store.finalizeWakeDeliveryAttempt({
      deliveryAttemptId: params.deliveryAttemptId,
      status: "delivered",
      ...(params.expectedClaimedBy ? { expectedClaimedBy: params.expectedClaimedBy } : {}),
      ...(params.evidence ? { evidence: params.evidence } : {}),
      attemptedAt: params.attemptedAt,
      deliveredAt: params.now,
      metadata: params.metadata,
      wakeStatus: "delivered",
      wakeAttemptCount: params.wake.attemptCount + 1,
      wakeLastAttemptAt: params.now,
      now: params.now,
    });
  }
  if (params.status === "failed") {
    return params.store.finalizeWakeDeliveryAttempt({
      deliveryAttemptId: params.deliveryAttemptId,
      status: "failed",
      ...(params.expectedClaimedBy ? { expectedClaimedBy: params.expectedClaimedBy } : {}),
      ...(params.evidence ? { evidence: params.evidence } : {}),
      ...(params.error ? { error: params.error } : {}),
      attemptedAt: params.attemptedAt,
      failedAt: params.now,
      metadata: params.metadata,
      wakeStatus: "failed",
      wakeAttemptCount: params.wake.attemptCount + 1,
      wakeLastAttemptAt: params.now,
      wakeFailedReason: params.error ?? "delivery_failed",
      now: params.now,
    });
  }
  return undefined;
}

function repairWakeOutcomeForTerminalAttempt(params: {
  store: DurableRuntimeStore;
  wake: DurableWake;
  attempt: DurableWakeDeliveryAttempt;
  now: number;
}): DurableWakeDeliveryAttempt {
  const outcomeAt =
    params.attempt.deliveredAt ??
    params.attempt.failedAt ??
    params.attempt.attemptedAt ??
    params.now;
  if (params.attempt.status === "delivered") {
    return (
      params.store.finalizeWakeDeliveryAttempt({
        deliveryAttemptId: params.attempt.deliveryAttemptId,
        status: "delivered",
        ...(params.attempt.evidence ? { evidence: params.attempt.evidence } : {}),
        ...(params.attempt.attemptedAt ? { attemptedAt: params.attempt.attemptedAt } : {}),
        ...(params.attempt.deliveredAt ? { deliveredAt: params.attempt.deliveredAt } : {}),
        ...(params.attempt.metadata ? { metadata: params.attempt.metadata } : {}),
        wakeStatus: "delivered",
        wakeAttemptCount: params.wake.attemptCount + 1,
        wakeLastAttemptAt: outcomeAt,
        now: params.now,
      }) ?? params.attempt
    );
  }
  if (params.attempt.status === "failed") {
    return (
      params.store.finalizeWakeDeliveryAttempt({
        deliveryAttemptId: params.attempt.deliveryAttemptId,
        status: "failed",
        ...(params.attempt.evidence ? { evidence: params.attempt.evidence } : {}),
        ...(params.attempt.error ? { error: params.attempt.error } : {}),
        ...(params.attempt.attemptedAt ? { attemptedAt: params.attempt.attemptedAt } : {}),
        ...(params.attempt.failedAt ? { failedAt: params.attempt.failedAt } : {}),
        ...(params.attempt.metadata ? { metadata: params.attempt.metadata } : {}),
        wakeStatus: "failed",
        wakeAttemptCount: params.wake.attemptCount + 1,
        wakeLastAttemptAt: outcomeAt,
        wakeFailedReason: params.attempt.error ?? "delivery_failed",
        now: params.now,
      }) ?? params.attempt
    );
  }
  return params.attempt;
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

function claimAttemptForDelivery(params: {
  store: DurableRuntimeStore;
  wake: DurableWake;
  attempt: DurableWakeDeliveryAttempt;
  replayPassId: string;
  claimTtlMs: number;
  now: number;
}): DurableWakeDeliveryAttempt | undefined {
  return params.store.claimWakeDeliveryAttempt({
    deliveryAttemptId: params.attempt.deliveryAttemptId,
    replayPassId: params.replayPassId,
    claimTtlMs: params.claimTtlMs,
    evidence: {
      kind: "wake_delivery_attempt_claimed",
      wakeId: params.wake.wakeId,
      previousStatus: params.attempt.status,
    },
    metadata: {
      deliveryContract: "durable_wake_delivery_replay_v1",
      replayPassId: params.replayPassId,
    },
    now: params.now,
  });
}

function startClaimRenewal(params: {
  store: DurableRuntimeStore;
  attempt: DurableWakeDeliveryAttempt;
  replayPassId: string;
  claimTtlMs: number;
}): () => void {
  const intervalMs = Math.max(1, Math.floor(params.claimTtlMs / 2));
  const interval = setInterval(() => {
    params.store.renewWakeDeliveryAttemptClaim({
      deliveryAttemptId: params.attempt.deliveryAttemptId,
      replayPassId: params.replayPassId,
      claimTtlMs: params.claimTtlMs,
    });
  }, intervalMs);
  return () => clearInterval(interval);
}

async function applyDeliveryHook(params: {
  store: DurableRuntimeStore;
  wake: DurableWake;
  attempt: DurableWakeDeliveryAttempt;
  deliveryHook: DurableWakeDeliveryHook;
  replayPassId: string;
  claimTtlMs: number;
  now?: number;
}): Promise<DurableWakeDeliveryAttempt> {
  const claimed = claimAttemptForDelivery({
    store: params.store,
    wake: params.wake,
    attempt: params.attempt,
    replayPassId: params.replayPassId,
    claimTtlMs: params.claimTtlMs,
    now: params.now ?? Date.now(),
  });
  if (!claimed) {
    return params.store.getWakeDeliveryAttempt(params.attempt.deliveryAttemptId) ?? params.attempt;
  }
  const stopClaimRenewal = startClaimRenewal({
    store: params.store,
    attempt: claimed,
    replayPassId: params.replayPassId,
    claimTtlMs: params.claimTtlMs,
  });
  try {
    const hookResult = await params.deliveryHook({
      wake: params.wake,
      attempt: claimed,
    });
    const outcomeAt = params.now ?? Date.now();
    const metadata = {
      deliveryContract: "durable_wake_delivery_replay_v1",
      replayPassId: params.replayPassId,
    };
    const attempt =
      (hookResult.status === "delivered" || hookResult.status === "failed"
        ? finalizeAttemptAndWakeOutcome({
            store: params.store,
            wake: params.wake,
            deliveryAttemptId: claimed.deliveryAttemptId,
            status: hookResult.status,
            expectedClaimedBy: params.replayPassId,
            ...(hookResult.evidence ? { evidence: hookResult.evidence } : {}),
            ...(hookResult.error ? { error: hookResult.error } : {}),
            attemptedAt: outcomeAt,
            metadata,
            now: outcomeAt,
          })
        : params.store.updateWakeDeliveryAttempt({
            deliveryAttemptId: claimed.deliveryAttemptId,
            status: hookResult.status,
            expectedClaimedBy: params.replayPassId,
            ...(hookResult.evidence ? { evidence: hookResult.evidence } : {}),
            ...(hookResult.error ? { error: hookResult.error } : {}),
            ...timestampForStatus(hookResult.status, outcomeAt),
            metadata,
            now: outcomeAt,
          })) ??
      params.store.getWakeDeliveryAttempt(claimed.deliveryAttemptId) ??
      claimed;
    return attempt;
  } catch (err) {
    const failedAt = params.now ?? Date.now();
    const error = err instanceof Error ? err.message : String(err);
    const metadata = {
      deliveryContract: "durable_wake_delivery_replay_v1",
      replayPassId: params.replayPassId,
    };
    const attempt =
      finalizeAttemptAndWakeOutcome({
        store: params.store,
        wake: params.wake,
        deliveryAttemptId: claimed.deliveryAttemptId,
        status: "failed",
        expectedClaimedBy: params.replayPassId,
        evidence: {
          kind: "wake_delivery_hook_error",
        },
        error,
        attemptedAt: failedAt,
        metadata,
        now: failedAt,
      }) ??
      params.store.getWakeDeliveryAttempt(claimed.deliveryAttemptId) ??
      claimed;
    return attempt;
  } finally {
    stopClaimRenewal();
  }
}

export async function replayDurableWakeDeliveryAttempts(params: {
  store: DurableRuntimeStore;
  replayPassId?: string;
  limit?: number;
  claimTtlMs?: number;
  now?: number;
  deliveryHook?: DurableWakeDeliveryHook;
}): Promise<DurableWakeDeliveryReplayResult> {
  const now = params.now ?? Date.now();
  const replayPassId = params.replayPassId ?? `wake-delivery-replay:${now}`;
  const claimTtlMs = params.claimTtlMs ?? DEFAULT_WAKE_DELIVERY_CLAIM_TTL_MS;
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
      const repaired = repairWakeOutcomeForTerminalAttempt({
        store: params.store,
        wake,
        attempt: existing,
        now,
      });
      result.deduped += 1;
      result.attempts.push(repaired);
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
        claimTtlMs,
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
