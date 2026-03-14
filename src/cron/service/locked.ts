import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();

/** Exposed for testing only — do not use in production code. */
export const storeLocks_TEST_ONLY = () => storeLocks;

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);

  // Keep the chain alive even when the operation fails.
  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);

  try {
    return (await next) as T;
  } finally {
    // Prune resolved entry if no subsequent operation replaced it.
    if (storeLocks.get(storePath) === keepAlive) {
      storeLocks.delete(storePath);
    }
  }
}
