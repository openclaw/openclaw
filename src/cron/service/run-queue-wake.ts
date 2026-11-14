import type { CronServiceState } from "./state.js";

const pendingQueues = new Map<CronServiceState, () => Promise<void>>();
const queueTurns = new Map<CronServiceState, Set<() => void>>();
const schedulers = new Map<CronServiceState, { refresh: () => void; drain: () => Promise<void> }>();

export function registerCronSchedulerRefresh(
  state: CronServiceState,
  refresh: () => void,
  drain: () => Promise<void>,
): () => void {
  schedulers.set(state, { refresh, drain });
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
  // A handed-over owner no longer drains, so its slot waiters need the replacement's drain.
  const handedOverWaiting = [...queueTurns.keys()].some(
    (owner) => owner.handedOver && owner.deps.storeKey === storeKey,
  );
  notifyCronRunQueueTurn(state);
  for (const [owner, { refresh, drain }] of schedulers) {
    if (owner.deps.storeKey === storeKey) {
      refresh();
      if (handedOverWaiting && !pendingQueues.has(owner)) {
        void drain().catch((error: unknown) =>
          owner.deps.log.warn({ err: String(error) }, "cron: queue drain delayed"),
        );
      }
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

/** Wakes slot waiters of every owner on this store: a reload's replacement hands them slots. */
export function notifyCronRunQueueTurn(state: CronServiceState): void {
  for (const [owner, waiters] of queueTurns) {
    if (owner.deps.storeKey === state.deps.storeKey) {
      // Each waiter removes itself from the set as it settles.
      for (const settle of waiters) {
        settle();
      }
    }
  }
}
