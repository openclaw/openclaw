// Process-local retry scheduler for the durable session delivery queue.
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { computeBackoffMs } from "./delivery-recovery.shared.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "./gateway-scheduler.js";
import {
  drainPendingSessionDelivery,
  type DeliverSessionDeliveryFn,
  type SessionDeliveryRecoveryLogger,
  type SettleSessionDeliveryFn,
} from "./session-delivery-queue-recovery.js";
import {
  loadPendingSessionDeliveries,
  loadPendingSessionDelivery,
} from "./session-delivery-queue-storage.js";
import {
  isProducedSessionDelivery,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";

type SessionDeliveryRuntime = {
  scheduler: GatewayScheduler;
  queueContext: OpenClawStateWorkerContext;
  deliver: DeliverSessionDeliveryFn;
  log: SessionDeliveryRecoveryLogger;
  onSettled?: SettleSessionDeliveryFn;
};

const RUNTIME_RELOAD_RETRY_MS = 1_000;
type ActiveSessionDeliveryRuntime = Omit<SessionDeliveryRuntime, "scheduler"> & {
  scheduler: GatewaySchedulerScope;
  runningEntries: Set<string>;
  pendingSchedules: Set<Promise<void>>;
};
let runtime: ActiveSessionDeliveryRuntime | undefined;

function armPendingScan(activeRuntime: ActiveSessionDeliveryRuntime): void {
  if (runtime !== activeRuntime) {
    return;
  }
  activeRuntime.scheduler.schedule({
    id: "session-delivery:scan",
    delayMs: RUNTIME_RELOAD_RETRY_MS,
    mode: "earliest",
    run: () => schedulePendingSessionDeliveries(),
  });
}

function resolveRetryDelayMs(entry: QueuedSessionDelivery, now: number): number {
  const claimDelayMs = Math.max(0, (entry.availableAt ?? 0) - now);
  if (entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion") {
    return Math.min(claimDelayMs, Math.max(0, entry.owner.deadlineAt - now));
  }
  if (entry.retryCount <= 0) {
    return claimDelayMs;
  }
  const attemptedAt = entry.lastAttemptAt ?? entry.enqueuedAt;
  return Math.max(claimDelayMs, attemptedAt + computeBackoffMs(entry.retryCount) - now);
}

function armSessionDeliveryId(
  id: string,
  delayMs: number,
  activeRuntime: ActiveSessionDeliveryRuntime,
): void {
  if (runtime !== activeRuntime) {
    return;
  }
  activeRuntime.scheduler.schedule({
    id: `session-delivery:${id}`,
    delayMs,
    mode: "earliest",
    run: () => runScheduledSessionDelivery(id, activeRuntime),
  });
}

function armSessionDelivery(
  entry: QueuedSessionDelivery,
  activeRuntime: ActiveSessionDeliveryRuntime,
  minimumDelayMs = 0,
): void {
  // The active drain owns rearming after its authoritative reload. Coalesce
  // duplicate schedules so they cannot poll the same due row in a timer loop.
  if (!isProducedSessionDelivery(entry) || activeRuntime.runningEntries.has(entry.id)) {
    return;
  }
  armSessionDeliveryId(
    entry.id,
    Math.max(minimumDelayMs, resolveRetryDelayMs(entry, activeRuntime.scheduler.now())),
    activeRuntime,
  );
}

async function runScheduledSessionDelivery(
  id: string,
  activeRuntime: ActiveSessionDeliveryRuntime,
): Promise<void> {
  if (runtime !== activeRuntime) {
    return;
  }
  if (activeRuntime.runningEntries.has(id)) {
    return;
  }
  activeRuntime.runningEntries.add(id);
  let pending: QueuedSessionDelivery | null = null;
  try {
    pending = await drainPendingSessionDelivery({
      id,
      queueContext: activeRuntime.queueContext,
      now: () => activeRuntime.scheduler.now(),
      logLabel: "session delivery",
      log: activeRuntime.log,
      deliver: activeRuntime.deliver,
      onSettled: activeRuntime.onSettled,
    });
  } catch (error) {
    activeRuntime.log.error(`session delivery: runtime drain failed for ${id}: ${String(error)}`);
    // The durable row may still be pending. Retry the exact drain so one
    // transient database error cannot orphan it until the next restart.
    armSessionDeliveryId(id, RUNTIME_RELOAD_RETRY_MS, activeRuntime);
  } finally {
    activeRuntime.runningEntries.delete(id);
  }
  if (pending) {
    // Any still-pending row means the drain deferred, failed, or was owned
    // elsewhere. Never poll an unchanged immediately-due row at timer speed.
    armSessionDelivery(pending, activeRuntime, RUNTIME_RELOAD_RETRY_MS);
  }
}

/** Register callbacks; stop fences scheduling and joins admitted reads and drains. */
export function startSessionDeliveryRuntime(params: SessionDeliveryRuntime): () => Promise<void> {
  runtime?.scheduler.beginClose();
  const activeRuntime = {
    ...params,
    scheduler: params.scheduler.scope(),
    runningEntries: new Set<string>(),
    pendingSchedules: new Set<Promise<void>>(),
  };
  runtime = activeRuntime;
  let stopPromise: Promise<void> | undefined;
  return () => {
    if (runtime === activeRuntime) {
      runtime = undefined;
    }
    // Public scheduling reads begin outside scheduler callbacks and must also
    // settle before this owner's queue database or environment is disposed.
    stopPromise ??= Promise.all([
      activeRuntime.scheduler.stop(),
      ...activeRuntime.pendingSchedules,
    ]).then(() => {});
    return stopPromise;
  };
}

/** Schedule one durable entry when a gateway runtime is available. */
export async function scheduleSessionDelivery(
  id: string,
  queueContext: OpenClawStateWorkerContext,
): Promise<boolean> {
  const activeRuntime = runtime;
  if (!activeRuntime) {
    return false;
  }
  try {
    queueContext.admission.assertCurrent();
    activeRuntime.queueContext.admission.assertCurrent();
    if (queueContext.admission.identity.key !== activeRuntime.queueContext.admission.identity.key) {
      activeRuntime.log.error(`session delivery: ${id} belongs to another state database`);
      return false;
    }
  } catch (error) {
    activeRuntime.log.error(
      `session delivery: cannot schedule ${id} for a retired state owner: ${String(error)}`,
    );
    return false;
  }
  const settled = createDeferredCore();
  activeRuntime.pendingSchedules.add(settled.promise);
  try {
    let entry: QueuedSessionDelivery | null;
    try {
      entry = await loadPendingSessionDelivery(id, activeRuntime.queueContext);
    } catch (error) {
      activeRuntime.log.error(`session delivery: failed to load ${id}: ${String(error)}`);
      armSessionDeliveryId(id, RUNTIME_RELOAD_RETRY_MS, activeRuntime);
      return true;
    }
    if (!entry || runtime !== activeRuntime) {
      return !entry;
    }
    armSessionDelivery(entry, activeRuntime);
    return true;
  } finally {
    activeRuntime.pendingSchedules.delete(settled.promise);
    settled.resolve();
  }
}

/** Schedule every pending entry after startup recovery installs the runtime owner. */
export async function schedulePendingSessionDeliveries(): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime) {
    return;
  }
  const settled = createDeferredCore();
  activeRuntime.pendingSchedules.add(settled.promise);
  try {
    let entries: QueuedSessionDelivery[];
    try {
      entries = await loadPendingSessionDeliveries(activeRuntime.queueContext);
    } catch (error) {
      activeRuntime.log.error(`session delivery: failed to scan pending entries: ${String(error)}`);
      armPendingScan(activeRuntime);
      return;
    }
    for (const entry of entries) {
      armSessionDelivery(entry, activeRuntime);
    }
  } finally {
    activeRuntime.pendingSchedules.delete(settled.promise);
    settled.resolve();
  }
}
