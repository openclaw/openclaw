import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

/**
 * Reset the store-level lock chain for a given path (or all paths).
 * Must be called when a cron service is torn down (e.g. SIGUSR1 restart)
 * so the new service instance doesn't wait on promises from the old one
 * that may never settle (e.g. an isolated agent job killed mid-execution).
 */
export function resetStoreLock(storePath?: string) {
  if (storePath) {
    storeLocks.delete(storePath);
  } else {
    storeLocks.clear();
  }
}

export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);

  // Keep the chain alive even when the operation fails.
  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);

  return (await next) as T;
}
