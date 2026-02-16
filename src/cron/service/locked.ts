import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

// Timeout helper to prevent indefinite blocking
const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> => {
  // Don't apply timeout in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return promise;
  }

  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Operation timed out after ${timeoutMs}ms: ${description}`)),
        timeoutMs,
      ),
    ),
  ]);
};

// Maximum time any single cron operation should take
const OPERATION_TIMEOUT_MS = 9500; // 9.5s to stay under the 10s gateway timeout

export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();

  // Add timeout to prevent indefinite blocking (except in tests)
  const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(() =>
    withTimeout(fn(), OPERATION_TIMEOUT_MS, `cron operation on ${storePath}`),
  );

  // Keep the chain alive even when the operation fails or times out.
  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);

  // Clean up old locks periodically to prevent memory leaks
  if (Math.random() < 0.01) {
    // 1% chance on each operation
    setTimeout(() => {
      // Remove locks that have been resolved for more than 30s
      for (const [path, lock] of storeLocks.entries()) {
        lock.then(() => {
          // If this lock has been resolved, check if we can remove it
          if (storeLocks.get(path) === lock) {
            setTimeout(() => {
              if (storeLocks.get(path) === lock) {
                storeLocks.delete(path);
              }
            }, 30000);
          }
        });
      }
    }, 0);
  }

  return (await next) as T;
}
