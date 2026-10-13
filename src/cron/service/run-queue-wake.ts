import { cronStoreKey } from "../store/key.js";
import type { CronServiceState } from "./state.js";

const pendingQueues = new Map<CronServiceState, () => Promise<void>>();
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
  const storeKey = cronStoreKey(state.deps.storePath);
  return [...pendingQueues.keys()].filter(
    (owner) => cronStoreKey(owner.deps.storePath) === storeKey,
  );
}

export function wakeCronRunQueues(state: CronServiceState): void {
  const storeKey = cronStoreKey(state.deps.storePath);
  for (const [owner, refresh] of schedulers) {
    if (cronStoreKey(owner.deps.storePath) === storeKey) {
      refresh();
    }
  }
  for (const [owner, drain] of pendingQueues) {
    if (cronStoreKey(owner.deps.storePath) === storeKey) {
      void drain().catch((error: unknown) =>
        owner.deps.log.warn({ err: String(error) }, "cron: queue drain delayed"),
      );
    }
  }
}
