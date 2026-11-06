/** Process-local cron operation serialization by SQLite store partition. */
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { prepareCronServiceStore, type CronServiceState } from "./state.js";

const cronOperations = new KeyedAsyncQueue();
type PendingCronSessionCleanup = { done: Promise<void>; agentId: string };
const pendingSessionCleanups = new Map<string, Map<string, PendingCronSessionCleanup>>();

/** Returns cleanup that must finish before the same durable job identity can be reused. */
export function getPendingCronSessionCleanup(
  state: CronServiceState,
  jobId: string,
): Promise<void> | undefined {
  return pendingSessionCleanups.get(state.deps.storeKey)?.get(jobId)?.done;
}

/** Registers cleanup at the store-partition owner shared by sibling service instances. */
export function registerPendingCronSessionCleanup(
  state: CronServiceState,
  jobId: string,
  done: Promise<void>,
  agentId: string,
): () => void {
  const storeKey = state.deps.storeKey;
  let byJobId = pendingSessionCleanups.get(storeKey);
  if (!byJobId) {
    byJobId = new Map<string, PendingCronSessionCleanup>();
    pendingSessionCleanups.set(storeKey, byJobId);
  }
  byJobId.set(jobId, { done, agentId });
  return () => {
    if (byJobId.get(jobId)?.done !== done) {
      return;
    }
    byJobId.delete(jobId);
    if (byJobId.size === 0) {
      pendingSessionCleanups.delete(storeKey);
    }
  };
}

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

/** Serializes operations by their actual SQLite partition and service-local order. */
export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const preparation = prepareCronServiceStore(state);
  if (preparation) {
    await preparation;
  }
  const previous = state.op;
  const next = cronOperations.enqueue(state.deps.storeKey, async () => {
    await resolveChain(previous);
    return await fn();
  });
  state.op = resolveChain(next);
  return await next;
}
