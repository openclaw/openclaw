import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncWorkScope, captureAsyncWorkTracker, getAsyncWorkSignal } from "./async-work-scope.js";
import { createDeferredCore } from "./deferred.js";

type AsyncWorkResources = { release: () => void | Promise<void> };

/** Returns the logical result while retaining resources through owned cleanup. */
export async function runWithAsyncWorkResources<T>(
  run: (
    onAcquired: (resources: AsyncWorkResources) => void,
    captureWorkContext: () => void,
  ) => Promise<T>,
): Promise<T> {
  const result = createDeferredCore<T>();
  const trackOwner = captureAsyncWorkTracker();
  const parentSignal = getAsyncWorkSignal();
  void trackOwner(async () => {
    const work = new AsyncWorkScope();
    let resources: AsyncWorkResources | undefined;
    let runInContext = work.run(() => AsyncLocalStorage.snapshot());
    const closeFromParent = () => runInContext(() => work.beginClose(parentSignal?.reason));
    parentSignal?.addEventListener("abort", closeFromParent, { once: true });
    if (parentSignal?.aborted) {
      closeFromParent();
    }
    try {
      result.resolve(
        await work.track(() =>
          run(
            (acquired) => {
              resources = acquired;
            },
            () => {
              runInContext = AsyncLocalStorage.snapshot();
            },
          ),
        ),
      );
    } catch (error) {
      result.reject(error);
    } finally {
      try {
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => runInContext(() => work.drain()),
        );
      } finally {
        parentSignal?.removeEventListener("abort", closeFromParent);
        await resources?.release();
      }
    }
  }).catch(result.reject);
  return await result.promise;
}
