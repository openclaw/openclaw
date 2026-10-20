import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { runWithTrackedCancellation } from "./async-work-resources.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
  isAsyncWorkScopeActiveHere,
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
  gates.splice(0).forEach((gate) => gate.resolve());
  while (background.length || scopes.length) {
    await Promise.allSettled(background.splice(0));
    await Promise.all(scopes.splice(0).map((scope) => scope.drain()));
  }
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});
function keep<T>(collection: T[], value: T): T {
  collection.push(value);
  return value;
}
const makeScope = () => keep(scopes, new AsyncWorkScope());
const makeGate = () => keep(gates, createDeferredCore());
const makeHeldScope = () => ({ scope: makeScope(), gate: makeGate() });
function own<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  background.push(promise);
  return promise;
}
function expectContext(signal: AbortSignal | undefined, ...active: [AsyncWorkScope, boolean][]) {
  expect(getAsyncWorkSignal()).toBe(signal);
  for (const [scope, expected] of active) {
    expect(isAsyncWorkScopeActiveHere(scope)).toBe(expected);
  }
}
async function expectClosed(track: typeof trackAsyncWork) {
  const late = vi.fn();
  await expect(track(late)).rejects.toThrow("Async work scope is closed");
  expect(late).not.toHaveBeenCalled();
}
async function releaseHeld(
  closing: Promise<unknown>,
  gate: Deferred,
  ...work: (Promise<unknown> | undefined)[]
) {
  const pending = Symbol("pending");
  await expect(Promise.race([closing, nextTurn().then(() => pending)])).resolves.toBe(pending);
  gate.resolve();
  await Promise.all([closing, ...work]);
}
// Released chunks retain this carrier while package replacement drains their work.
const carrier = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncWorkScope"),
  () => new AsyncLocalStorage<AsyncWorkScope>(),
);

it("accepts nested work without re-entering its current context", async () => {
  const [outer, inner] = [makeScope(), makeScope()];
  await outer.track(() =>
    inner.track(async () => {
      await Promise.resolve();
      const entries = vi.spyOn(AsyncLocalStorage.prototype, "run");
      await trackAsyncWork(() =>
        inner.run(() => expectContext(inner.signal, [outer, true], [inner, true])),
      );
      expect(entries).not.toHaveBeenCalled();
      entries.mockRestore();
      await outer.track(() => expectContext(outer.signal, [inner, true]));
      expect(getAsyncWorkSignal()).toBe(inner.signal);
    }),
  );
  expect(getAsyncWorkSignal()).toBeUndefined();
});

it.each([false, true])(
  "keeps cancellation and accepted work after foreground settlement (fails=%s)",
  async (fails) => {
    const { scope: owner, gate: finishWork } = makeHeldScope();
    const requester = new AbortController();
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
    const { scope, gate: finish } = makeHeldScope();
    const work =
      direction === "released caller"
        ? carrier.run(scope, () => trackAsyncWork(() => finish.promise))
        : scope.run(() => carrier.getStore()!.track(() => finish.promise));
    await releaseHeld(own(scope.drain()), finish, work);
  },
);

it("does not inherit scope ancestry through a released detach helper", async () => {
  const [owner, detached] = [makeScope(), makeScope()];
  await owner.track(() =>
    carrier.exit(() => {
      expect(isAsyncWorkScopeActiveHere(owner)).toBe(false);
      return detached.track(() => expectContext(detached.signal, [owner, false], [detached, true]));
    }),
  );
});

it("excludes newly admitted disposal work while another owner enters its next phase", async () => {
  const [first, second] = [makeScope(), makeScope()];
  const [finishAbort, finishDisposal, disposalStarted] = [makeGate(), makeGate(), makeGate()];
  let disposing = false;
  const events: string[] = [];
  const abortWork = first.track(() => finishAbort.promise);
  const selectScopes = () => (disposing ? [second] : [first, second]);
  const disposal = own(
    AsyncWorkScope.runWhenAllIdle(selectScopes, () =>
      first.track(async () => {
        disposing = true;
        disposalStarted.resolve();
        await finishDisposal.promise;
        events.push("disposed");
      }),
    ),
  );
  const nextPhase = own(
    AsyncWorkScope.runWhenAllIdle(selectScopes, () => second.track(() => events.push("second"))),
  );
  finishAbort.resolve();
  await disposalStarted.promise;
  await nextTurn();
  expect(events).toEqual(["second"]);
  finishDisposal.resolve();
  await Promise.all([abortWork, disposal, nextPhase]);
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
  const value = scope.run(() => thenable);
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

it.each(["sync", "async"] as const)(
  "joins %s descendants through drain and fences late work",
  async (mode) => {
    const { scope, gate } = makeHeldScope();
    let child: Promise<void> | undefined;
    let closing: Promise<void>;
    const startChild = () => {
      child = trackAsyncWork(() => {
        expect(getAsyncWorkSignal()).toBe(scope.signal);
        return gate.promise;
      });
    };
    if (mode === "sync") {
      closing = scope.run(() => {
        const drain = own(scope.drain());
        startChild();
        return drain;
      });
    } else {
      await scope.track(async () => {
        await Promise.resolve();
        startChild();
      });
      closing = own(scope.drain());
    }
    expect(scope.signal.aborted).toBe(true);
    expect(getAsyncWorkSignal()).toBeUndefined();
    await releaseHeld(closing, gate, child);
    const late = vi.fn();
    expect(() => scope.run(late)).toThrow("Async work scope is closed");
    expect(late).not.toHaveBeenCalled();
  },
);

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
  await expectClosed(track);
  await drained;
});

it("does not close or drain an independent scope", async () => {
  const [first, second] = [makeScope(), makeScope()];
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
  expect([completed, second.signal.aborted]).toEqual([[0], false]);
});

it.each([true, false])(
  "captures work ownership without copying caller context (owned=%s)",
  async (owned) => {
    const [owner, caller] = [makeScope(), makeScope()];
    const authorization = new AsyncLocalStorage<string>();
    cleanups.push(() => authorization.disable());
    const gate = makeGate();
    const track = owned
      ? await authorization.run("requested", () => owner.track(captureAsyncWorkTracker))
      : captureAsyncWorkTracker();
    let producer: Promise<void> | undefined;
    let descendant: Promise<void> | undefined;
    await authorization.run("invoker", () =>
      caller.track(() => {
        expectContext(caller.signal, [caller, true], [owner, false]);
        producer = track(async () => {
          expect(authorization.getStore()).toBe("invoker");
          expectContext(owned ? owner.signal : undefined, [owner, owned], [caller, owned]);
          await Promise.resolve();
          descendant = own(trackAsyncWork(() => gate.promise));
        });
      }),
    );
    expectContext(undefined, [caller, false], [owner, false]);
    await producer;
    const closing = own(owned ? owner.drain() : descendant!);
    await caller.drain();
    await releaseHeld(closing, gate, descendant);
    if (owned) {
      await expectClosed(track);
    }
  },
);

it("rejects a late async continuation before invoking its producer", async () => {
  const { scope, gate } = makeHeldScope();
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
