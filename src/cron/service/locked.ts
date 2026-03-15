import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

/**
 * Clear the store lock for a given path.
 * This should be called when the cron service is stopped to prevent
 * stale promises from blocking subsequent operations.
 */
export function clearStoreLock(storePath: string): void {
  storeLocks.delete(storePath);
}

/**
 * Clear all store locks.
 * This is primarily for testing purposes.
 */
export function clearAllStoreLocks(): void {
  storeLocks.clear();
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
