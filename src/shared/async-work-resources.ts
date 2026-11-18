import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncWorkScope, captureAsyncWorkTracker, getAsyncWorkSignal } from "./async-work-scope.js";
import { createDeferredCore, type Deferred } from "./deferred.js";

type AsyncWorkResources = {
  release: () => void | Promise<void>;
  /** Preserve synchronous operation settlement unless admitted work still owns it. */
  releaseBeforeResultWhenIdle?: true;
};

// The retained release callback must not capture the foreground producer or result.
function createContextualCancellationRelay(signal: AbortSignal) {
  const controller = new AbortController();
  const context = AsyncLocalStorage.snapshot();
  const abort = () => context(() => controller.abort(signal.reason));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  return {
    signal: controller.signal,
    release: () => signal.removeEventListener("abort", abort),
  };
}

/** Preserves cancellation context until cooperating work ends, without delaying its result. */
export async function runWithTrackedCancellation<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  if (!getAsyncWorkSignal()) {
    return await run(signal);
  }
  return await runWithAsyncWorkResources(async (onAcquired) => {
    const relay = createContextualCancellationRelay(signal);
    onAcquired({ release: relay.release });
    return run(relay.signal);
  });
}

/** Returns the logical result while retaining resources through owned cleanup. */
export async function runWithAsyncWorkResources<T>(
  run: (
    onAcquired: (resources: AsyncWorkResources) => void,
    captureWorkContext: () => void,
  ) => Promise<T>,
  options?: { cancelOnError: boolean },
): Promise<T> {
  // Cleanup owns resources, not the settled foreground promise or its producer.
  let settlement: Deferred<T> | undefined = createDeferredCore<T>();
  const result = settlement.promise;
  let foreground: typeof run | undefined = run;
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
      let value: T | undefined = await work.track(() => {
        const invoke = foreground!;
        foreground = undefined;
        return invoke(
          (acquired) => {
            resources = acquired;
          },
          () => {
            runInContext = AsyncLocalStorage.snapshot();
          },
        );
      });
      if (resources?.releaseBeforeResultWhenIdle && !work.hasPendingWork) {
        const completedResources = resources;
        resources = undefined;
        await runInContext(() => work.drain());
        await completedResources.release();
      }
      settlement?.resolve(value);
      settlement = undefined;
      value = undefined;
    } catch (error) {
      // Callers abandoning work on failure must join its cleanup before retrying.
      if (options?.cancelOnError) {
        runInContext(() => work.beginClose(error));
        await runInContext(() => work.drain());
      }
      settlement?.reject(error);
      settlement = undefined;
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
  }).catch((error: unknown) => {
    settlement?.reject(error);
    settlement = undefined;
  });
  return await result;
}
