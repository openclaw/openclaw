import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferredCore } from "./deferred.js";
import { resolveGlobalSingleton } from "./global-singleton.js";

// Lazy runtime chunks share the context carrier, never the lifetime of its owners.
const currentWorkScope = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncWorkScope"),
  () => new AsyncLocalStorage<AsyncWorkScope>(),
);

/** Joins cooperating descendants even when their caller returns a cached value first. */
export class AsyncWorkScope {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private phase: "open" | "closing" | "closed" = "open";

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isClosing(): boolean {
    return this.phase !== "open";
  }

  /** Enters synchronous work without inspecting or assimilating its return value. */
  run<T>(run: () => T): T {
    if (this.phase === "closed") {
      throw new Error("Async work scope is closed");
    }
    const operation = this.registerWork<void>();
    try {
      return currentWorkScope.run(this, run);
    } finally {
      operation.resolve();
    }
  }

  track<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.phase === "closed") {
      return Promise.reject(new Error("Async work scope is closed"));
    }
    // Register before invoking without delaying received node results behind
    // a subsequent socket-close event. Async descendants inherit this exact owner.
    const operation = this.registerWork<T>();
    try {
      operation.resolve(currentWorkScope.run(this, run));
    } catch (error) {
      operation.reject(error);
    }
    return operation.promise;
  }

  private registerWork<T>() {
    const operation = createDeferredCore<T>();
    this.pending.add(operation.promise);
    void operation.promise.then(
      () => this.pending.delete(operation.promise),
      () => this.pending.delete(operation.promise),
    );
    return operation;
  }

  beginClose(reason?: unknown): void {
    if (this.phase !== "open") {
      return;
    }
    this.phase = "closing";
    this.controller.abort(reason);
  }

  /** Starts the next phase in the same continuation that observes settled pending work. */
  runWhenIdle<T>(run: () => T | Promise<T>): Promise<T> {
    return AsyncWorkScope.runWhenAllIdle(
      () => [this],
      () => this.track(run),
    );
  }

  /** Reselects owners so work admitted into a later phase is not mistaken for earlier work. */
  static async runWhenAllIdle<T>(
    selectScopes: () => readonly AsyncWorkScope[],
    run: () => T | Promise<T>,
  ): Promise<T> {
    let scopes = selectScopes();
    do {
      await Promise.allSettled(scopes.flatMap((scope) => [...scope.pending]));
      scopes = selectScopes();
    } while (scopes.some((scope) => scope.pending.size > 0));
    return run();
  }

  async drain(): Promise<void> {
    this.beginClose();
    // An admitted parent can register a cleanup tail while it settles.
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
    this.phase = "closed";
  }
}

/** Outside a managed scope, the returned promise remains the caller's responsibility. */
export async function trackAsyncWork<T>(run: () => T | Promise<T>): Promise<T> {
  const scope = currentWorkScope.getStore();
  return await (scope ? scope.track(run) : run());
}

/** Captures only work ownership, never the caller's authorization or other async context. */
export function captureAsyncWorkTracker(): typeof trackAsyncWork {
  const scope = currentWorkScope.getStore();
  return async (run) => await (scope ? scope.track(run) : currentWorkScope.exit(run));
}

export function getAsyncWorkSignal(): AbortSignal | undefined {
  return currentWorkScope.getStore()?.signal;
}

/** Preserves cancellation context until cooperating work ends, without delaying its result. */
export async function runWithTrackedCancellation<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  const parentWork = currentWorkScope.getStore();
  if (!parentWork) {
    return await run(signal);
  }
  const result = createDeferredCore<T>();
  // The parent owns cleanup before invocation, but the caller only waits for its result.
  void parentWork
    .track(async () => {
      const work = new AsyncWorkScope();
      const controller = new AbortController();
      const context = work.run(() => AsyncLocalStorage.snapshot());
      const abort = () => context(() => controller.abort(signal.reason));
      const closeWork = () => context(() => work.beginClose(parentWork.signal.reason));
      signal.addEventListener("abort", abort, { once: true });
      parentWork.signal.addEventListener("abort", closeWork, { once: true });
      if (signal.aborted) {
        abort();
      }
      if (parentWork.signal.aborted) {
        closeWork();
      }
      try {
        result.resolve(await work.track(() => run(controller.signal)));
      } catch (error) {
        result.reject(error);
      } finally {
        try {
          await AsyncWorkScope.runWhenAllIdle(
            () => [work],
            () => context(() => work.drain()),
          );
        } finally {
          signal.removeEventListener("abort", abort);
          parentWork.signal.removeEventListener("abort", closeWork);
        }
      }
    })
    .catch(result.reject);
  return await result.promise;
}
