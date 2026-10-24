import { AsyncResource, type AsyncLocalStorage } from "node:async_hooks";

/** Enter once; the resource restores the caller's frame without copying it again. */
export function runWithAsyncStore<T, R>(
  storage: Pick<AsyncLocalStorage<T>, "getStore" | "enterWith">,
  value: T,
  run: () => R,
): R {
  if (storage.getStore() === value) {
    return run();
  }
  return new AsyncResource("OpenClawAsyncStore").runInAsyncScope(() => {
    storage.enterWith(value);
    return run();
  });
}
