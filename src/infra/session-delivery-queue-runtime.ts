// Process-local retry scheduler for the durable session delivery queue.
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { computeBackoffMs } from "./delivery-recovery.shared.js";
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
import type { QueuedSessionDelivery } from "./session-delivery-queue.records.js";

type SessionDeliveryRuntime = {
  queueContext: OpenClawStateWorkerContext;
  deliver: DeliverSessionDeliveryFn;
  drain?: typeof drainPendingSessionDelivery;
  log: SessionDeliveryRecoveryLogger;
  reloadPending?: typeof loadPendingSessionDelivery;
  listPending?: typeof loadPendingSessionDeliveries;
  onSettled?: SettleSessionDeliveryFn;
};

const RUNTIME_RELOAD_RETRY_MS = 1_000;
export type SessionDeliveryObservation = {
  signal: AbortSignal;
  canReconcileAfterDrain(): boolean;
};
type RuntimeObserver = {
  owner: ActiveSessionDeliveryRuntime;
  lifetime: AbortController;
  settled: Promise<void>;
};
type ActiveSessionDeliveryRuntime = SessionDeliveryRuntime & {
  runningEntries: Map<string, Promise<void>>;
  pendingSchedules: Set<Promise<void>>;
  observers: Set<RuntimeObserver>;
  predecessorDrains: Set<Promise<void>>;
  drained: boolean;
  reconcileAfterDrain: boolean;
  drainCompletion?: Promise<void>;
  retirement?: Promise<void>;
};
let runtime: ActiveSessionDeliveryRuntime | undefined;
let runtimeGeneration = 0;
const scheduledEntries = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number }>();
let pendingScanTimer: ReturnType<typeof setTimeout> | undefined;

function clearScheduledEntries(): void {
  for (const scheduled of scheduledEntries.values()) {
    clearTimeout(scheduled.timer);
  }
  scheduledEntries.clear();
  if (pendingScanTimer) {
    clearTimeout(pendingScanTimer);
    pendingScanTimer = undefined;
  }
}

function armPendingScan(generation: number): void {
  if (!runtime || generation !== runtimeGeneration || pendingScanTimer) {
    return;
  }
  pendingScanTimer = setTimeout(() => {
    pendingScanTimer = undefined;
    void schedulePendingSessionDeliveries();
  }, RUNTIME_RELOAD_RETRY_MS);
  pendingScanTimer.unref?.();
}

function resolveRetryDelayMs(entry: QueuedSessionDelivery): number {
  const claimDelayMs = Math.max(0, (entry.availableAt ?? 0) - Date.now());
  const deadlineDelayMs =
    entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion"
      ? Math.max(0, entry.owner.deadlineAt - Date.now())
      : Number.POSITIVE_INFINITY;
  if (entry.retryCount <= 0) {
    return Math.min(claimDelayMs, deadlineDelayMs);
  }
  if (entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion") {
    return Math.min(deadlineDelayMs, claimDelayMs);
  }
  const attemptedAt = entry.lastAttemptAt ?? entry.enqueuedAt;
  return Math.min(
    deadlineDelayMs,
    Math.max(claimDelayMs, attemptedAt + computeBackoffMs(entry.retryCount) - Date.now()),
  );
}

function armSessionDeliveryId(id: string, delayMs: number, generation: number): void {
  if (!runtime || generation !== runtimeGeneration) {
    return;
  }
  // Native timers measure elapsed time, so preemption deadlines must ignore wall-clock jumps.
  const dueAt = performance.now() + delayMs;
  const existing = scheduledEntries.get(id);
  if (existing && existing.dueAt <= dueAt) {
    return;
  }
  if (existing) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    scheduledEntries.delete(id);
    void runScheduledSessionDelivery(id, generation);
  }, delayMs);
  timer.unref?.();
  scheduledEntries.set(id, { timer, dueAt });
}

function armSessionDelivery(
  entry: QueuedSessionDelivery,
  generation: number,
  minimumDelayMs = 0,
): void {
  // The active drain owns rearming after its authoritative reload. Coalesce
  // duplicate schedules so they cannot poll the same due row in a timer loop.
  if (runtime?.runningEntries.has(entry.id)) {
    return;
  }
  armSessionDeliveryId(entry.id, Math.max(minimumDelayMs, resolveRetryDelayMs(entry)), generation);
}

async function runScheduledSessionDelivery(id: string, generation: number): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime || generation !== runtimeGeneration) {
    return;
  }
  if (activeRuntime.runningEntries.has(id)) {
    return;
  }
  const settled = createDeferredCore();
  activeRuntime.runningEntries.set(id, settled.promise);
  let pending: QueuedSessionDelivery | null = null;
  try {
    pending = await (activeRuntime.drain ?? drainPendingSessionDelivery)({
      id,
      queueContext: activeRuntime.queueContext,
      logLabel: "session delivery",
      log: activeRuntime.log,
      deliver: activeRuntime.deliver,
      onSettled: activeRuntime.onSettled,
    });
  } catch (error) {
    activeRuntime.log.error(`session delivery: runtime drain failed for ${id}: ${String(error)}`);
    if (runtime && generation === runtimeGeneration) {
      // The durable row may still be pending. Retry the exact drain so one
      // transient database error cannot orphan it until the next restart.
      armSessionDeliveryId(id, RUNTIME_RELOAD_RETRY_MS, generation);
    }
  } finally {
    activeRuntime.runningEntries.delete(id);
    settled.resolve();
  }
  if (!runtime || generation !== runtimeGeneration) {
    return;
  }
  if (pending) {
    // Any still-pending row means the drain deferred, failed, or was owned
    // elsewhere. Never poll an unchanged immediately-due row at timer speed.
    armSessionDelivery(pending, generation, RUNTIME_RELOAD_RETRY_MS);
  }
}

function sharesCurrentQueue(
  left: ActiveSessionDeliveryRuntime,
  right: ActiveSessionDeliveryRuntime,
): boolean {
  try {
    left.queueContext.admission.assertCurrent();
    right.queueContext.admission.assertCurrent();
    return left.queueContext.admission.identity.key === right.queueContext.admission.identity.key;
  } catch {
    return false;
  }
}

function joinRuntimeDrains(activeRuntime: ActiveSessionDeliveryRuntime): Promise<void> {
  activeRuntime.drainCompletion ??= Promise.all([
    ...activeRuntime.predecessorDrains,
    ...activeRuntime.runningEntries.values(),
    ...activeRuntime.pendingSchedules,
  ]).then(() => {
    activeRuntime.drained = true;
  });
  return activeRuntime.drainCompletion;
}

function retireRuntime(activeRuntime: ActiveSessionDeliveryRuntime): Promise<void> {
  activeRuntime.retirement ??= joinRuntimeDrains(activeRuntime).then(async () => {
    // Admitted delivery can still settle during shutdown. Let observers consume
    // that final result before the caller disposes the queue's database owner.
    const observers = [...activeRuntime.observers];
    for (const observer of observers) {
      observer.lifetime.abort();
    }
    await Promise.all(observers.map((observer) => observer.settled));
  });
  return activeRuntime.retirement;
}

/** Register callbacks; stop fences scheduling and joins delivery before its observers. */
export function startSessionDeliveryRuntime(params: SessionDeliveryRuntime): () => Promise<void> {
  const previous = runtime;
  runtimeGeneration += 1;
  const generation = runtimeGeneration;
  clearScheduledEntries();
  const activeRuntime: ActiveSessionDeliveryRuntime = {
    ...params,
    runningEntries: new Map<string, Promise<void>>(),
    pendingSchedules: new Set<Promise<void>>(),
    observers: new Set(),
    predecessorDrains: new Set(),
    drained: false,
    reconcileAfterDrain: true,
  };
  runtime = activeRuntime;
  if (previous) {
    const sameQueue = sharesCurrentQueue(previous, activeRuntime);
    previous.reconcileAfterDrain = sameQueue;
    if (sameQueue) {
      // Every same-store replacement joins its predecessor's active sends,
      // including ordinary deliveries that have no media observer.
      const predecessorDrain = joinRuntimeDrains(previous);
      activeRuntime.predecessorDrains.add(predecessorDrain);
      void predecessorDrain.then(() => activeRuntime.predecessorDrains.delete(predecessorDrain));
      for (const observer of previous.observers) {
        observer.owner = activeRuntime;
        activeRuntime.observers.add(observer);
      }
      previous.observers.clear();
    }
    void retireRuntime(previous);
  }
  return () => {
    if (runtimeGeneration === generation) {
      runtimeGeneration += 1;
      runtime = undefined;
      clearScheduledEntries();
    }
    return retireRuntime(activeRuntime);
  };
}

/** Detached producers need a live owner to deliver and observe their queued completion. */
export function hasSessionDeliveryRuntime(): boolean {
  return runtime !== undefined && runtime.retirement === undefined;
}

/** Join local observations before shutdown without cancelling the durable delivery itself. */
export async function observeSessionDeliveryRuntime<T>(
  observe: (observation: SessionDeliveryObservation | undefined) => Promise<T>,
): Promise<T> {
  const activeRuntime = runtime;
  if (!activeRuntime) {
    return await observe(undefined);
  }
  const settled = createDeferredCore();
  const observer: RuntimeObserver = {
    owner: activeRuntime,
    lifetime: new AbortController(),
    settled: settled.promise,
  };
  activeRuntime.observers.add(observer);
  try {
    return await observe({
      signal: observer.lifetime.signal,
      canReconcileAfterDrain: () => {
        if (!observer.owner.drained || !observer.owner.reconcileAfterDrain) {
          return false;
        }
        try {
          observer.owner.queueContext.admission.assertCurrent();
          return runtime === undefined || sharesCurrentQueue(observer.owner, runtime);
        } catch {
          return false;
        }
      },
    });
  } finally {
    observer.owner.observers.delete(observer);
    settled.resolve();
  }
}

/** Schedule one durable entry when a gateway runtime is available. */
export async function scheduleSessionDelivery(
  id: string,
  queueContext: OpenClawStateWorkerContext,
): Promise<boolean> {
  const generation = runtimeGeneration;
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
      entry = await (activeRuntime.reloadPending ?? loadPendingSessionDelivery)(
        id,
        activeRuntime.queueContext,
      );
    } catch (error) {
      activeRuntime.log.error(`session delivery: failed to load ${id}: ${String(error)}`);
      armSessionDeliveryId(id, RUNTIME_RELOAD_RETRY_MS, generation);
      return true;
    }
    if (!entry || !runtime || generation !== runtimeGeneration) {
      return !entry;
    }
    armSessionDelivery(entry, generation);
    return true;
  } finally {
    activeRuntime.pendingSchedules.delete(settled.promise);
    settled.resolve();
  }
}

/** Schedule every pending entry after startup recovery installs the runtime owner. */
export async function schedulePendingSessionDeliveries(): Promise<void> {
  const generation = runtimeGeneration;
  const activeRuntime = runtime;
  if (!activeRuntime) {
    return;
  }
  const settled = createDeferredCore();
  activeRuntime.pendingSchedules.add(settled.promise);
  try {
    let entries: QueuedSessionDelivery[];
    try {
      entries = await (activeRuntime.listPending ?? loadPendingSessionDeliveries)(
        activeRuntime.queueContext,
      );
    } catch (error) {
      activeRuntime.log.error(`session delivery: failed to scan pending entries: ${String(error)}`);
      armPendingScan(generation);
      return;
    }
    if (!runtime || generation !== runtimeGeneration) {
      return;
    }
    for (const entry of entries) {
      armSessionDelivery(entry, generation);
    }
  } finally {
    activeRuntime.pendingSchedules.delete(settled.promise);
    settled.resolve();
  }
}
