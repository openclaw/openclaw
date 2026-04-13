import { clearSessionStoreCaches } from "./store-cache.js";
import {
  clearLoadedSessionStoreSnapshotsForTest,
  clearSessionObjectCacheLimitWarningsForTest,
} from "./store-load.js";

export type SessionStoreLockTask = {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutMs?: number;
  staleMs: number;
};

export type SessionStoreLockQueue = {
  running: boolean;
  pending: SessionStoreLockTask[];
  drainPromise: Promise<void> | null;
};

export const LOCK_QUEUES = new Map<string, SessionStoreLockQueue>();

export function clearSessionStoreCacheForTest(): void {
  clearSessionStoreCaches();
  clearSessionObjectCacheLimitWarningsForTest();
  clearLoadedSessionStoreSnapshotsForTest();
  for (const queue of LOCK_QUEUES.values()) {
    for (const task of queue.pending) {
      task.reject(new Error("session store queue cleared for test"));
    }
  }
  LOCK_QUEUES.clear();
}

export async function drainSessionStoreLockQueuesForTest(): Promise<void> {
  while (LOCK_QUEUES.size > 0) {
    const queues = [...LOCK_QUEUES.values()];
    for (const queue of queues) {
      for (const task of queue.pending) {
        task.reject(new Error("session store queue cleared for test"));
      }
      queue.pending.length = 0;
    }
    const activeDrains = queues.flatMap((queue) =>
      queue.drainPromise ? [queue.drainPromise] : [],
    );
    if (activeDrains.length === 0) {
      LOCK_QUEUES.clear();
      return;
    }
    await Promise.allSettled(activeDrains);
  }
}

export function getSessionStoreLockQueueSizeForTest(): number {
  return LOCK_QUEUES.size;
}
