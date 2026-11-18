import { AsyncResource, type AsyncLocalStorage } from "node:async_hooks";

function enterAsyncStore<T, R>(
  this: Pick<AsyncLocalStorage<T>, "enterWith">,
  value: T,
  run: () => R,
): R {
  this.enterWith(value);
  return run();
}

/** Enter once; the resource restores the caller's frame without copying it again. */
export function runWithAsyncStore<T, R>(
  storage: Pick<AsyncLocalStorage<T>, "getStore" | "enterWith">,
  value: T,
  run: () => R,
): R {
  if (storage.getStore() === value) {
    return run();
  }
  return new AsyncResource("OpenClawAsyncStore").runInAsyncScope(
    enterAsyncStore<T, R>,
    storage,
    value,
    run,
  );
}
