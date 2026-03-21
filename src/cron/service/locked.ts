import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();
const STORE_LOCKS_MAX = 256;

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
  if (storeLocks.size > STORE_LOCKS_MAX) {
    const oldest = storeLocks.keys().next();
    if (!oldest.done) {
      storeLocks.delete(oldest.value);
    }
  }

  return (await next) as T;
}
