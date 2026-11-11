import type { CronServiceState } from "./state.js";

const pendingQueues = new Map<CronServiceState, () => Promise<void>>();
const queueTurns = new Map<CronServiceState, Set<() => void>>();
const schedulers = new Map<CronServiceState, () => void>();

export function registerCronSchedulerRefresh(
  state: CronServiceState,
  refresh: () => void,
): () => void {
  schedulers.set(state, refresh);
  return () => {
    schedulers.delete(state);
  };
}

/** Only services with pending launch contexts receive same-store wake notifications. */
export function registerCronRunQueue(state: CronServiceState, drain: () => Promise<void>): void {
  pendingQueues.set(state, drain);
}

export function releaseCronRunQueue(state: CronServiceState): void {
  pendingQueues.delete(state);
}

export function listCronRunQueueOwners(state: CronServiceState): CronServiceState[] {
  const storeKey = state.deps.storeKey;
  return [...pendingQueues.keys()].filter((owner) => owner.deps.storeKey === storeKey);
}

export function wakeCronRunQueues(state: CronServiceState): void {
  const storeKey = state.deps.storeKey;
  for (const owner of queueTurns.keys()) {
    if (owner.deps.storeKey === storeKey) {
      notifyCronRunQueueTurn(owner);
    }
  }
  for (const [owner, refresh] of schedulers) {
    if (owner.deps.storeKey === storeKey) {
      refresh();
    }
  }
  for (const [owner, drain] of pendingQueues) {
    if (owner.deps.storeKey === storeKey) {
      void drain().catch((error: unknown) =>
        owner.deps.log.warn({ err: String(error) }, "cron: queue drain delayed"),
      );
    }
  }
}

/**
 * Waits for the next moment a run slot may have freed: a run on this store ended or a tick
 * landed. Also settles on abort; `cancel` withdraws the wait once it is no longer needed.
 */
export function awaitCronRunQueueTurn(
  state: CronServiceState,
  signal: AbortSignal,
): { turn: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const turn = new Promise<void>((resolve) => {
    const waiters = queueTurns.get(state) ?? new Set();
    queueTurns.set(state, waiters);
    cancel = () => {
      signal.removeEventListener("abort", cancel);
      waiters.delete(cancel);
      if (!waiters.size && queueTurns.get(state) === waiters) {
        queueTurns.delete(state);
      }
      resolve();
    };
    waiters.add(cancel);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
  });
  return { turn, cancel };
}

export function notifyCronRunQueueTurn(state: CronServiceState): void {
  // Each waiter removes itself from the set as it settles.
  for (const settle of queueTurns.get(state) ?? []) {
    settle();
  }
}
