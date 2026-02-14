import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();
const storeReadLocks = new Map<string, Promise<void>>();

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

  return (await next) as T;
}

export async function lockedRead<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  // Read operations only wait for previous reads and writes to the store file,
  // but NOT for job executions (state.op) which can run for minutes.
  const storePath = state.deps.storePath;
  const storeWriteOp = storeLocks.get(storePath) ?? Promise.resolve();
  const storeReadOp = storeReadLocks.get(storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(storeWriteOp), resolveChain(storeReadOp)]).then(fn);

  const keepAlive = resolveChain(next);
  storeReadLocks.set(storePath, keepAlive);

  return (await next) as T;
}
