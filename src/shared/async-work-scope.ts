import { AsyncLocalStorage } from "node:async_hooks";
import "./detached-async-context.js";
import { runWithAsyncStore } from "./async-store.js";
import { createDeferredCore } from "./deferred.js";
import { resolveGlobalSingleton } from "./global-singleton.js";

type AsyncWorkScopeFrame = { scope: AsyncWorkScope; parent?: AsyncWorkScopeFrame };

// Lazy runtime chunks share the context carrier, never the lifetime of its owners.
const currentWorkScope = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncWorkScope"),
  () => new AsyncLocalStorage<AsyncWorkScope | undefined>(),
);
// Keep the shipped owner carrier intact when replacement chunks join a live process.
const currentWorkScopeAncestry = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncWorkScopeAncestry"),
  () => new AsyncLocalStorage<AsyncWorkScopeFrame | undefined>(),
);

// Replacement chunks reject through the same class so callers can classify lifecycle refusals.
export const AsyncWorkScopeClosedError = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncWorkScopeClosedError"),
  () =>
    class ClosedError extends Error {
      constructor() {
        super("Async work scope is closed");
        this.name = "AsyncWorkScopeClosedError";
      }
    },
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
    if (owner === this) {
      return run();
    }
    const ancestry = currentWorkScopeAncestry.getStore();
    const parent = owner ? (ancestry?.scope === owner ? ancestry : { scope: owner }) : undefined;
    return runWithAsyncStore(currentWorkScope, this, () => {
      currentWorkScopeAncestry.enterWith({ scope: this, parent });
      return run();
    });
  }

  /** Enters synchronous work without inspecting or assimilating its return value. */
  run<T>(run: () => T): T {
    if (this.phase === "closed") {
      throw new AsyncWorkScopeClosedError();
    }
    // Existing work already makes reentrant drain yield until this synchronous call returns.
    if (this.pending.size > 0) {
      return this.enter(run);
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
      return Promise.reject(new AsyncWorkScopeClosedError());
    }
    // Register before invoking without delaying received node results behind
    // a subsequent socket-close event. Async descendants inherit this exact owner.
    const operation = createDeferredCore<T>();
    this.pending.add(operation.promise);
    void operation.promise.then(
      () => this.pending.delete(operation.promise),
      (error: unknown) => {
        this.pending.delete(operation.promise);
        this.failures?.add(error);
      },
    );
    try {
      operation.resolve(this.enter(run));
    } catch (error) {
      operation.reject(error);
    }
    return operation.promise;
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

/** Retains accepted work across Gateway close handles and successor scope generations. */
export class GatewayRetainedWorkScope {
  private work = new AsyncWorkScope();
  private readonly scopes = new Set([this.work]);
  private gateways = 0;
  private closing = false;

  constructor(private readonly assertSettled?: () => void) {}

  get scope(): AsyncWorkScope {
    return this.work;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  get hasGateways(): boolean {
    return this.gateways > 0;
  }

  reopen(): void {
    this.work = new AsyncWorkScope();
    this.scopes.add(this.work);
    this.closing = false;
  }

  private drain(scope: AsyncWorkScope): Promise<void> {
    return AsyncWorkScope.runWhenAllIdle(
      () => [scope],
      async () => {
        await scope.drain();
        this.assertSettled?.();
        this.scopes.delete(scope);
      },
    );
  }

  beginDrainAll(): Promise<void[]> {
    this.closing = true;
    return Promise.all([...this.scopes].map((scope) => this.drain(scope)));
  }

  retainGateway() {
    if (this.closing) {
      this.reopen();
    }
    this.gateways += 1;
    let released = false;
    let pending: Promise<void> | undefined;
    const beginClose = () => {
      if (!released) {
        released = true;
        if (--this.gateways === 0) {
          this.closing = true;
          pending = this.drain(this.work);
          void pending.catch(() => {});
        }
      }
    };
    return {
      beginClose,
      drain: () => {
        beginClose();
        return pending ?? Promise.resolve();
      },
    };
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
  if (currentWorkScope.getStore() === undefined) {
    return currentWorkScopeAncestry.getStore() === undefined
      ? run()
      : currentWorkScopeAncestry.exit(run);
  }
  // One isolated frame restores both carriers without copying each on exit.
  return runWithAsyncStore(currentWorkScope, undefined, () => {
    currentWorkScopeAncestry.enterWith(undefined);
    return run();
  });
}

export function getAsyncWorkSignal(): AbortSignal | undefined {
  return currentWorkScope.getStore()?.signal;
}
