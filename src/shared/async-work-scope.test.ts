import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
  isAsyncWorkScopeActiveHere,
  runWithTrackedCancellation,
  trackAsyncWork,
} from "./async-work-scope.js";
import { createDeferredCore, type Deferred } from "./deferred.js";
import { resolveGlobalSingleton } from "./global-singleton.js";

const scopes: AsyncWorkScope[] = [];
const gates: Deferred[] = [];
const background: Promise<unknown>[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  // Release gates and join descendants before closing their owners.
  for (const gate of gates.splice(0)) {
    gate.resolve();
  }
  while (background.length) {
    await Promise.allSettled(background.splice(0));
  }
  await Promise.all(scopes.splice(0).map((scope) => scope.drain()));
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
});
function makeScope() {
  const scope = new AsyncWorkScope();
  scopes.push(scope);
  return scope;
}
function makeGate() {
  const gate = createDeferredCore();
  gates.push(gate);
  return gate;
}
function observe<T>(promise: Promise<T>) {
  const settled = vi.fn();
  void promise.then(settled, settled);
  background.push(promise);
  return { promise, settled };
}
async function releaseHeld(
  closing: ReturnType<typeof observe>,
  gate: Deferred,
  ...work: (Promise<unknown> | undefined)[]
) {
  await nextTurn();
  expect(closing.settled).not.toHaveBeenCalled();
  gate.resolve();
  await Promise.all([closing.promise, ...work]);
  expect(closing.settled).toHaveBeenCalledOnce();
}
// Released chunks retain this carrier while package replacement drains their work.
const carrier = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncWorkScope"),
  () => new AsyncLocalStorage<AsyncWorkScope>(),
);

it("accepts nested work without re-entering its current context", async () => {
  const outer = makeScope();
  const inner = makeScope();
  await outer.track(() =>
    inner.track(async () => {
      await Promise.resolve();
      const entries = vi.spyOn(AsyncLocalStorage.prototype, "run");
      try {
        await trackAsyncWork(() =>
          inner.run(() => {
            expect(getAsyncWorkSignal()).toBe(inner.signal);
            expect(isAsyncWorkScopeActiveHere(outer)).toBe(true);
            expect(isAsyncWorkScopeActiveHere(inner)).toBe(true);
          }),
        );
        expect(entries).not.toHaveBeenCalled();
      } finally {
        entries.mockRestore();
      }
      await outer.track(() => {
        expect(getAsyncWorkSignal()).toBe(outer.signal);
        expect(isAsyncWorkScopeActiveHere(inner)).toBe(true);
      });
      expect(getAsyncWorkSignal()).toBe(inner.signal);
    }),
  );
  expect(getAsyncWorkSignal()).toBeUndefined();
});

it.each([false, true])(
  "keeps cancellation and accepted work after foreground settlement (fails=%s)",
  async (fails) => {
    const owner = makeScope();
    const requester = new AbortController();
    const finishWork = makeGate();
    const failure = new Error("foreground failed");
    let operationSignal: AbortSignal | undefined;
    let workSignal: AbortSignal | undefined;
    const result = owner.run(() =>
      runWithTrackedCancellation(requester.signal, (signal) => {
        operationSignal = signal;
        workSignal = getAsyncWorkSignal();
        void trackAsyncWork(() => finishWork.promise);
        if (fails) {
          throw failure;
        }
        return "accepted";
      }),
    );
    if (fails) {
      await expect(result).rejects.toBe(failure);
    } else {
      expect(await result).toBe("accepted");
    }
    expect(owner.hasPendingWork).toBe(true);
    const cancelReason = new Error("requester cancelled");
    requester.abort(cancelReason);
    expect(operationSignal?.reason).toBe(cancelReason);
    const closeReason = new Error("owner closing");
    owner.beginClose(closeReason);
    expect(workSignal?.reason).toBe(closeReason);
    expect(owner.hasPendingWork).toBe(true);
    finishWork.resolve();
    await owner.drain();
    expect(owner.hasPendingWork).toBe(false);
  },
);

it.each(["released caller", "released helper"])(
  "joins work across the shipped scope carrier with a %s",
  async (direction) => {
    const scope = makeScope();
    const finish = makeGate();
    const work =
      direction === "released caller"
        ? carrier.run(scope, () => trackAsyncWork(() => finish.promise))
        : scope.run(() => carrier.getStore()!.track(() => finish.promise));
    const closing = observe(scope.drain());
    await releaseHeld(closing, finish, work);
  },
);

it("does not inherit scope ancestry through a released detach helper", async () => {
  const owner = makeScope();
  const detached = makeScope();
  await owner.track(() =>
    carrier.exit(() => {
      expect(isAsyncWorkScopeActiveHere(owner)).toBe(false);
      return detached.track(() => {
        expect(isAsyncWorkScopeActiveHere(owner)).toBe(false);
        expect(isAsyncWorkScopeActiveHere(detached)).toBe(true);
      });
    }),
  );
});

it("excludes newly admitted disposal work while another owner enters its next phase", async () => {
  const first = makeScope();
  const second = makeScope();
  const finishAbort = makeGate();
  const finishDisposal = makeGate();
  const disposalStarted = makeGate();
  let disposing = false;
  const disposed = vi.fn();
  const secondStarted = vi.fn();
  const abortWork = first.track(() => finishAbort.promise);
  const selectScopes = () => (disposing ? [second] : [first, second]);
  const disposal = observe(
    AsyncWorkScope.runWhenAllIdle(selectScopes, () =>
      first.track(async () => {
        disposing = true;
        disposalStarted.resolve();
        await finishDisposal.promise;
        disposed();
      }),
    ),
  );
  const nextPhase = observe(
    AsyncWorkScope.runWhenAllIdle(selectScopes, () => second.track(secondStarted)),
  );
  finishAbort.resolve();
  await disposalStarted.promise;
  await nextTurn();
  expect(secondStarted).toHaveBeenCalledOnce();
  expect(disposed).not.toHaveBeenCalled();
  finishDisposal.resolve();
  await Promise.all([abortWork, disposal.promise, nextPhase.promise]);
});

it("preserves synchronous returns and throws without inspecting a thenable", async () => {
  const scope = makeScope();
  const readThen = vi.fn(() => {
    throw new Error("The synchronous caller owns thenable inspection");
  });
  const thenable = {
    // oxlint-disable-next-line unicorn/no-thenable -- The synchronous entry must leave this thenable untouched.
    get then() {
      return readThen();
    },
  };
  const value = scope.run(() => {
    expect(getAsyncWorkSignal()).toBe(scope.signal);
    return thenable;
  });
  expect(value === thenable).toBe(true);
  const failure = new Error("synchronous failure");
  const throws = vi.fn(() =>
    scope.run(() => {
      throw failure;
    }),
  );
  expect(throws).toThrow();
  expect(throws.mock.results[0]?.value).toBe(failure);
  await scope.drain();
  expect(readThen).not.toHaveBeenCalled();
});

it("admits synchronous work before a reentrant drain and joins its descendant", async () => {
  const scope = makeScope();
  const gate = makeGate();
  let child: Promise<void> | undefined;
  const closing = scope.run(() => {
    const drain = observe(scope.drain());
    child = trackAsyncWork(() => gate.promise);
    return drain;
  });
  await releaseHeld(closing, gate, child);
  const late = vi.fn();
  expect(() => scope.run(late)).toThrow("Async work scope is closed");
  expect(late).not.toHaveBeenCalled();
});

it("settles work for cleanup without closing its captured tracker, then fences final drain", async () => {
  const scope = makeScope();
  const track = await scope.track(captureAsyncWorkTracker);
  scope.beginClose();
  const cleanup = vi.fn(() => Promise.resolve());
  await scope.runWhenIdle(() => {
    expect(getAsyncWorkSignal()).toBe(scope.signal);
    return track(cleanup);
  });
  expect(cleanup).toHaveBeenCalledOnce();
  const drained = scope.drain();
  const late = vi.fn();
  await expect(track(late)).rejects.toThrow("Async work scope is closed");
  expect(late).not.toHaveBeenCalled();
  await drained;
});

it("joins an inherited descendant after its parent returns", async () => {
  const scope = makeScope();
  const gate = makeGate();
  let child: Promise<void> | undefined;
  await scope.track(async () => {
    await Promise.resolve();
    child = trackAsyncWork(async () => {
      expect(getAsyncWorkSignal()).toBe(scope.signal);
      await gate.promise;
    });
  });
  const closing = observe(scope.drain());
  expect(scope.signal.aborted).toBe(true);
  expect(getAsyncWorkSignal()).toBeUndefined();
  await releaseHeld(closing, gate, child);
});

it("does not close or drain an independent scope", async () => {
  const first = makeScope();
  const second = makeScope();
  const releases = [makeGate(), makeGate()];
  const completed: number[] = [];
  await Promise.all(
    [first, second].map((scope, index) =>
      scope.track(async () => {
        await Promise.resolve();
        void trackAsyncWork(async () => {
          await releases[index]!.promise;
          completed.push(index);
        });
      }),
    ),
  );
  releases[0]!.resolve();
  await first.drain();
  expect(completed).toEqual([0]);
  expect(second.signal.aborted).toBe(false);
});

it("captures descendant work ownership without copying another async context", async () => {
  const owner = makeScope();
  const caller = makeScope();
  const authorization = new AsyncLocalStorage<string>();
  cleanups.push(() => authorization.disable());
  const gate = makeGate();
  const track = await authorization.run("requested", () => owner.track(captureAsyncWorkTracker));
  let producer: Promise<void> | undefined;
  let descendant: Promise<void> | undefined;
  await authorization.run("invoker", () =>
    caller.track(() => {
      expect(isAsyncWorkScopeActiveHere(caller)).toBe(true);
      expect(isAsyncWorkScopeActiveHere(owner)).toBe(false);
      producer = track(async () => {
        expect(authorization.getStore()).toBe("invoker");
        expect(getAsyncWorkSignal()).toBe(owner.signal);
        expect(isAsyncWorkScopeActiveHere(owner)).toBe(true);
        expect(isAsyncWorkScopeActiveHere(caller)).toBe(true);
        await Promise.resolve();
        descendant = trackAsyncWork(() => gate.promise);
      });
    }),
  );
  expect(isAsyncWorkScopeActiveHere(caller)).toBe(false);
  expect(isAsyncWorkScopeActiveHere(owner)).toBe(false);
  await producer;
  const closing = observe(owner.drain());
  await caller.drain();
  await releaseHeld(closing, gate, descendant);
  const staleProducer = vi.fn();
  await expect(track(staleProducer)).rejects.toThrow("Async work scope is closed");
  expect(staleProducer).not.toHaveBeenCalled();
});

it("keeps an unscoped capture caller-owned when invoked inside a later scope", async () => {
  const track = captureAsyncWorkTracker();
  const caller = makeScope();
  const gate = makeGate();
  let producer: Promise<void> | undefined;
  const descendantSettled = vi.fn();
  await caller.track(() => {
    producer = observe(
      track(() => {
        expect(getAsyncWorkSignal()).toBeUndefined();
        expect(isAsyncWorkScopeActiveHere(caller)).toBe(false);
        observe(trackAsyncWork(() => gate.promise.then(descendantSettled)));
      }),
    ).promise;
  });
  await producer;
  await caller.drain();
  expect(descendantSettled).not.toHaveBeenCalled();
});

it("rejects a late async continuation before invoking its producer", async () => {
  const scope = makeScope();
  const gate = makeGate();
  const producer = vi.fn();
  let continuation: Promise<unknown> | undefined;
  await scope.track(() => {
    continuation = gate.promise.then(() => trackAsyncWork(producer));
  });
  await scope.drain();
  gate.resolve();
  await expect(continuation).rejects.toThrow("Async work scope is closed");
  expect(producer).not.toHaveBeenCalled();
});
