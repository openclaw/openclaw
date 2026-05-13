import type { CronServiceState } from "./state.js";

const operationChains = new Map<string, Promise<void>>();

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const scopeKey = state.deps.storeKey;
  const scopeOp = operationChains.get(scopeKey) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op), resolveChain(scopeOp)]).then(fn);

  // Keep the chain alive even when the operation fails.
  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  operationChains.set(scopeKey, keepAlive);

  return (await next) as T;
}
