import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../agents/run-termination.js";
import {
  beginSessionEffect as beginAdmission,
  captureSessionWorkRunInterruptions as captureRuns,
  collectSessionControllerTargets,
  consumeSessionEffectHandoff as consumeHandoff,
  getSessionControllerWorkCount,
  getCompetingSessionWorkAdmissionRelease as getCompetingRelease,
  captureSessionControllerSettlement as getRelease,
  interruptSessionControllerEffects as interrupt,
  isCompetingSessionControllerWorkActive as competingActive,
  isSessionControllerWorkActive as workActive,
  observeSessionControllerProtectionReleases,
  captureGatewaySessionControllerWork as captureGateway,
  runSessionMutation as mutate,
  startSessionControllerInterruption as startInterruption,
} from "./session-controller.lifecycle.js";

const admit = (params: Parameters<typeof beginAdmission>[0]) =>
  beginAdmission({ assertAllowed: () => {}, ...params });
function makeTarget<T extends string[]>(scope: string, ...identities: T) {
  return { scope, identities };
}
function ownedTarget(scope: string, ...identities: string[]) {
  return { ...makeTarget(scope, ...identities), owner: Symbol(scope), serializeOwner: true };
}
function gate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}
function admissionOutcome(pending: ReturnType<typeof beginAdmission>) {
  return pending.then(
    (lease) => {
      lease.release();
      return "incorrectly admitted";
    },
    (error: unknown) => error,
  );
}

it("notifies only the released scope when acquired identity protection shrinks", async () => {
  const scope = "release-observer.sqlite";
  let handoffId = "";
  const listener = vi.fn(() => {
    expect(workActive(scope, ["shared"])).toBe(false);
    expect(consumeHandoff({ handoffId, scope, identities: ["shared"] })).toBeUndefined();
  });
  const otherListener = vi.fn();
  const unsubscribe = observeSessionControllerProtectionReleases(` ${scope} `, listener);
  const unsubscribeOther = observeSessionControllerProtectionReleases(
    "other.sqlite",
    otherListener,
  );
  const first = await beginAdmission({ scope, identities: ["shared"] });
  const second = await beginAdmission({ scope, identities: ["shared"] });
  handoffId = second.createHandoff();
  const unrelated = await beginAdmission({ scope, identities: ["unrelated"] });
  try {
    first.release();
    expect(listener).not.toHaveBeenCalled();
    second.release();
    second.release();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(otherListener).not.toHaveBeenCalled();
    expect(workActive(scope, ["unrelated"])).toBe(true);
    unsubscribe();
    unrelated.release();
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    unsubscribeOther();
    first.release();
    second.release();
    unrelated.release();
  }
});

it.each(["completed", "cancelled", "cancelled-then-restart", "restart", "timeout"] as const)(
  "uses the adopted run's %s outcome when capturing restart work",
  async (outcome) => {
    const scope = "settling-restart.sqlite";
    const sessionKey = "agent:main:settling";
    const sessionId = "settling-session";
    const identity = makeTarget(scope, sessionKey, sessionId);
    const resolveGatewayContext = () => undefined;
    const admission = await admit({
      ...identity,
      resolveGatewayContext,
      isSettling: () => false,
    });
    let settled = false;
    const reason =
      outcome === "restart"
        ? createAgentRunRestartAbortError()
        : outcome.startsWith("cancelled")
          ? createAgentRunDirectAbortError()
          : outcome === "timeout"
            ? Object.assign(new Error("timed out"), { name: "TimeoutError" })
            : undefined;
    const target = { scope, sessionKey, sessionId };
    const captured = captureGateway(resolveGatewayContext);
    try {
      expect(captured.isActive(target)).toBe(true);
      expect(
        consumeHandoff({
          handoffId: admission.createHandoff(),
          ...identity,
          isSettling: () => settled,
          getAbortReason: () => reason,
        }),
      ).toBe(admission);
      settled = true;
      if (outcome === "cancelled-then-restart") {
        startInterruption({
          ...identity,
          reason: createAgentRunRestartAbortError(),
        });
      }
      const recoverable = !outcome.startsWith("cancelled");
      expect(captured.isActive(target)).toBe(recoverable);
      expect(captureGateway(resolveGatewayContext).isActive(target)).toBe(recoverable);
      expect(workActive(scope, [sessionKey, sessionId])).toBe(true);
    } finally {
      admission.release();
    }
  },
);

it.each(["released", "interrupted", "undeclared", "caller", "wrong receipt"] as const)(
  "targeted run interruption rejects a %s admission",
  async (state) => {
    const target = { scope: "capture-current.sqlite", identities: ["capture-current-session"] };
    const run = { runId: "captured-run" };
    const onInterrupt = vi.fn(() => ({
      runId: state === "wrong receipt" ? "different-run" : run.runId,
    }));
    const admission = await admit({
      ...target,
      ...(state === "undeclared" ? {} : { run }),
      onInterrupt,
    });
    const capture = () => captureRuns({ ...target, accept: () => true });
    try {
      const captured = state === "caller" ? await admission.run(async () => capture()) : capture();
      if (state === "undeclared" || state === "caller") {
        expect(captured).toEqual([]);
        expect(onInterrupt).not.toHaveBeenCalled();
        return;
      }
      expect(captured).toHaveLength(1);
      if (state === "released") {
        admission.release();
      } else if (state === "interrupted") {
        startInterruption(target);
        onInterrupt.mockClear();
      }
      expect(captured[0]!.interrupt(createAgentRunDirectAbortError())).toBe(false);
      expect(onInterrupt).toHaveBeenCalledTimes(state === "wrong receipt" ? 1 : 0);
      const remaining = capture();
      if (state === "interrupted" || state === "wrong receipt") {
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!.interrupt(createAgentRunDirectAbortError())).toBe(false);
        const released = vi.fn();
        const completion = remaining[0]!.released.then(released);
        await Promise.resolve();
        expect(released).not.toHaveBeenCalled();
        admission.release();
        await completion;
        expect(released).toHaveBeenCalledOnce();
        expect(capture()).toEqual([]);
      } else {
        expect(remaining).toEqual([]);
      }
    } finally {
      admission.release();
    }
  },
);

it("serializes pending owners in FIFO order without blocking other owners", async ({ signal }) => {
  const serialized = {
    ...ownedTarget("serialized.sqlite", "agent:main:serialized", "session"),
    signal,
  };
  const barrier = gate();
  const order: string[] = [];
  const first = admit({
    ...serialized,
    assertAllowed: async () => {
      await barrier.wait();
      order.push("first");
    },
    revalidateAllowed: () => {},
  });
  await withinTest(barrier.entered, signal);
  const follow = (name: string) =>
    admit({
      ...serialized,
      identities: [serialized.identities[1]],
      assertAllowed: () => void order.push(name),
      revalidateAllowed: () => {},
    });
  const followers = [follow("second"), follow("third")] as const;
  const passOtherOwner = async () => {
    (await admit({ ...serialized, owner: Symbol("independent-owner") })).release();
  };
  try {
    barrier.release();
    for (const [index, pending] of [first, followers[0]].entries()) {
      const lease = await withinTest(pending, signal);
      await withinTest(passOtherOwner(), signal);
      expect(order).toEqual(["first", "second", "third"].slice(0, index + 1));
      lease.release();
    }
    (await withinTest(followers[1], signal)).release();
    expect(order).toEqual(["first", "second", "third"]);
  } finally {
    barrier.release();
    for (const attempt of [first, ...followers]) {
      await attempt.then(
        (lease) => lease.release(),
        () => {},
      );
    }
  }
});

it("lets an inherited owner finish ahead of its queued successor", async ({ signal }) => {
  const target = { ...ownedTarget("nested-owner.sqlite", "nested-owner-session"), signal };
  const outer = await admit(target);
  const validateFollower = vi.fn();
  const follower = admit({ ...target, assertAllowed: validateFollower });
  try {
    await withinTest(
      outer.run(async () => {
        (await admit(target)).release();
      }),
      signal,
    );
    expect(outer.isActive()).toBe(true);
    expect(validateFollower).not.toHaveBeenCalled();
  } finally {
    outer.release();
    await follower.then(
      (lease) => lease.release(),
      () => {},
    );
  }
  expect(validateFollower).toHaveBeenCalled();
});

it.for(["caller abort", "Stop", "targeted Stop"])(
  "cancels a pending owner wait on %s before its predecessor releases",
  async (cancellation, { signal }) => {
    const owned = ownedTarget(`cancel-owner-${cancellation}.sqlite`, "cancel-owner-session");
    const { scope, identities } = owned;
    const controller = new AbortController();
    const reason = createAgentRunDirectAbortError();
    const predecessorInterrupt = vi.fn();
    const predecessor = await admit({ ...owned, onInterrupt: predecessorInterrupt });
    const validate = vi.fn();
    const run = { runId: "queued-run" };
    const onInterrupt = vi.fn(() => ({ runId: run.runId }));
    const pending = admissionOutcome(
      admit({
        ...owned,
        ...(cancellation === "targeted Stop"
          ? { run, onInterrupt }
          : { signal: AbortSignal.any([controller.signal, signal]) }),
        assertAllowed: validate,
      }),
    );
    try {
      (await admit({ scope, identities, signal })).release();
      if (cancellation === "caller abort") {
        controller.abort(reason);
      } else if (cancellation === "targeted Stop") {
        const captured = captureRuns({ ...owned, accept: () => true });
        expect(captured).toHaveLength(1);
        expect(captured[0]!.interrupt(reason)).toBe(true);
        expect(captured[0]!.interrupt(reason)).toBe(false);
        expect(onInterrupt).toHaveBeenCalledOnce();
      } else {
        await predecessor.run(async () => {
          const interrupted = startInterruption({ scope, identities, reason });
          await withinTest(interrupted.released, signal);
        });
      }
      expect(await withinTest(pending, signal)).toBe(reason);
      expect(validate).not.toHaveBeenCalled();
      expect(predecessorInterrupt).not.toHaveBeenCalled();
      expect(predecessor.isActive()).toBe(true);
    } finally {
      controller.abort(reason);
      predecessor.release();
      await pending;
    }
  },
);

it("rejects arrivals during awaited cleanup and its final microtask, then reopens only after release", async () => {
  const scope = "hostile-await.sqlite";
  const identities: [string, string] = ["agent:main:fence", "fence-session"];
  const barrier = gate();
  const reason = createAgentRunDirectAbortError();
  const onInterrupt = vi.fn();
  let lateResult: unknown;
  const late = () => admissionOutcome(admit({ scope, identities, onInterrupt }));
  const stop = mutate({
    scope,
    identities,
    prepare: async (owner) => {
      owner.closeWorkAdmissions(reason);
      await barrier.wait();
    },
    run: async () => {},
    finalize: async () => {
      await Promise.resolve();
      lateResult = await late();
    },
  });
  await barrier.entered;
  try {
    const whileAwaiting = await late();
    expect(whileAwaiting).toBe(reason);
    expect(onInterrupt).toHaveBeenCalledExactlyOnceWith(reason);
    (await admit({ scope, identities: ["other-session"] })).release();
    barrier.release();
    await stop;
    expect(lateResult).toBe(reason);
    expect(onInterrupt).toHaveBeenCalledTimes(2);
    (await admit({ scope, identities, onInterrupt })).release();
    expect(onInterrupt).toHaveBeenCalledTimes(2);
  } finally {
    barrier.release();
    await stop;
  }
});

it("interrupts a preexisting non-chat pending attempt without classifying it as active work", async () => {
  const owner = makeTarget("non-chat-pending.sqlite", "agent:main:pending", "pending-session");
  const { scope, identities } = owner;
  const resolveGatewayContext = () => undefined;
  const barrier = gate();
  const interrupted = vi.fn();
  const validate = vi.fn();
  const blocker = mutate({ ...owner, prepare: barrier.wait, run: async () => {} });
  await barrier.entered;
  const pending = admissionOutcome(
    admit({
      ...owner,
      onInterrupt: interrupted,
      resolveGatewayContext,
      assertAllowed: validate,
    }),
  );
  try {
    expect(workActive(scope, identities)).toBe(false);
    expect(
      captureGateway(resolveGatewayContext).isActive({
        scope,
        sessionKey: identities[0],
        sessionId: identities[1],
      }),
    ).toBe(false);
    expect(competingActive(scope, identities)).toBe(false);
    expect(getRelease({ scope, identities })).toBeUndefined();
    const competingRelease = getCompetingRelease({ scope, identities });
    expect(competingRelease).toBeDefined();
    expect(collectSessionControllerTargets().get(scope)).toBeUndefined();
    expect(getSessionControllerWorkCount()).toBe(0);
    const reason = createAgentRunDirectAbortError();
    expect(await interrupt({ scope, identities, reason, timeoutMs: 1000 })).toBe(true);
    expect(await pending).toBe(reason);
    await expect(competingRelease).resolves.toBeUndefined();
    expect(interrupted).toHaveBeenCalledExactlyOnceWith(reason);
    expect(validate).not.toHaveBeenCalled();
  } finally {
    barrier.release();
    await blocker;
    await pending;
  }
});

it.each(["compaction", "single-use iterator"] as const)(
  "%s queues work behind the exact lifecycle fence without deadlocking release queries",
  async (mode) => {
    const owner = makeTarget(`${mode}.sqlite`, `${mode}-session`);
    const { scope, identities } = owner;
    const barrier = gate();
    const validate = vi.fn();
    const mutation = mutate({
      ...owner,
      ...(mode === "compaction" ? { kind: "compaction" as const } : {}),
      prepare: async () => {
        await barrier.wait();
        if (mode === "compaction") {
          await getRelease(owner);
        }
      },
      run: async () => {},
    });
    await barrier.entered;
    const admission = admit({
      scope,
      identities: mode === "compaction" ? identities : identities.values(),
      assertAllowed: validate,
    });
    try {
      if (mode === "single-use iterator") {
        (await admit({ scope, identities: ["unrelated-generator"] })).release();
      }
      expect(validate).not.toHaveBeenCalled();
      barrier.release();
      await mutation;
      (await admission).release();
      expect(validate).toHaveBeenCalledOnce();
    } finally {
      barrier.release();
      await mutation;
      (await admission).release();
    }
  },
);

it("an initial validator finishing after pending cancellation cannot enter the writer", async () => {
  const owner = makeTarget("initial-validator.sqlite", "initial-validator-session");
  const barrier = gate();
  const writer = vi.fn();
  const released = vi.fn();
  const unsubscribe = observeSessionControllerProtectionReleases(owner.scope, released);
  const reason = createAgentRunDirectAbortError();
  const pending = admissionOutcome(
    admit({ ...owner, assertAllowed: barrier.wait, revalidateAllowed: writer }),
  );
  await barrier.entered;
  try {
    const interruption = startInterruption({ ...owner, reason });
    const drained = vi.fn();
    void interruption.released.then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    expect(released).not.toHaveBeenCalled();
    barrier.release();
    expect(await pending).toBe(reason);
    await interruption.released;
    // Cancellation retains validator custody without acquiring identity protection.
    await mutate({ ...owner, run: async () => {} });
    expect(writer).not.toHaveBeenCalled();
    expect(released).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    barrier.release();
    await pending;
  }
});
