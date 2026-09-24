import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { createDeferredCore } from "./deferred.js";
import { resolveGlobalSingleton } from "./global-singleton.js";

type AsyncWorkScopeFrame = { scope: AsyncWorkScope; parent?: AsyncWorkScopeFrame };

// Lazy runtime chunks share the context carrier, never the lifetime of its owners.
const currentWorkScope = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncWorkScope"),
  () => new AsyncLocalStorage<AsyncWorkScope>(),
);
// Keep the shipped owner carrier intact when replacement chunks join a live process.
const currentWorkScopeAncestry = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncWorkScopeAncestry"),
  () => new AsyncLocalStorage<AsyncWorkScopeFrame>(),
);
const detachedAsyncContext = resolveGlobalSingleton(
  Symbol.for("openclaw.detachedAsyncContext"),
  () => new AsyncResource("openclaw.detached-async-context"),
);

/** Joins cooperating descendants even when their caller returns a cached value first. */
export class AsyncWorkScope {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private phase: "open" | "closing" | "closed" = "open";

  constructor(private readonly failures?: Set<unknown>) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get hasPendingWork(): boolean {
    return this.pending.size > 0;
  }

  get isClosing(): boolean {
    return this.phase !== "open";
  }

  private enter<T>(run: () => T): T {
    const owner = currentWorkScope.getStore();
    const ancestry = currentWorkScopeAncestry.getStore();
    const parent = owner ? (ancestry?.scope === owner ? ancestry : { scope: owner }) : undefined;
    return currentWorkScopeAncestry.run({ scope: this, parent }, () =>
      currentWorkScope.run(this, run),
    );
  }

  /** Enters synchronous work without inspecting or assimilating its return value. */
  run<T>(run: () => T): T {
    if (this.phase === "closed") {
      throw new Error("Async work scope is closed");
    }
    // Synchronous work is removed in finally and needs no promise cleanup reactions.
    const operation = createDeferredCore();
    this.pending.add(operation.promise);
    try {
      return this.enter(run);
    } finally {
      operation.resolve();
      this.pending.delete(operation.promise);
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
      operation.resolve(this.enter(run));
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
      (error: unknown) => {
        this.pending.delete(operation.promise);
        this.failures?.add(error);
      },
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
    while (scopes.some((scope) => scope.pending.size > 0)) {
      await Promise.allSettled(scopes.flatMap((scope) => Array.from(scope.pending)));
      scopes = selectScopes();
    }
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

/** Inspect retained scopes by identity, including instances created by a released runtime. */
export function isAsyncWorkScopeActiveHere(scope: AsyncWorkScope): boolean {
  const owner = currentWorkScope.getStore();
  if (owner === scope) {
    return true;
  }
  const ancestry = currentWorkScopeAncestry.getStore();
  // Released detach helpers clear only the owner carrier.
  if (!owner || ancestry?.scope !== owner) {
    return false;
  }
  for (let frame: AsyncWorkScopeFrame | undefined = ancestry; frame; frame = frame.parent) {
    if (frame.scope === scope) {
      return true;
    }
  }
  return false;
}

/** Outside a managed scope, the returned promise remains the caller's responsibility. */
export async function trackAsyncWork<T>(run: () => T | Promise<T>): Promise<T> {
  const scope = currentWorkScope.getStore();
  return await (scope ? scope.track(run) : run());
}

/** Captures only work ownership, never the caller's authorization or other async context. */
export function captureAsyncWorkTracker(): typeof trackAsyncWork {
  const scope = currentWorkScope.getStore();
  return async (run) => await (scope ? scope.track(run) : runOutsideAsyncWorkScope(run));
}

/** Starts work its caller does not own, so the caller's scope neither waits for it nor closes under it. */
export function runOutsideAsyncWorkScope<T>(run: () => T): T {
  return currentWorkScope.exit(() => currentWorkScopeAncestry.exit(run));
}

/** Runs under the context-free async root initialized before managed work can begin. */
export function runInDetachedAsyncContext<T>(run: () => T): T {
  return detachedAsyncContext.runInAsyncScope(run);
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
