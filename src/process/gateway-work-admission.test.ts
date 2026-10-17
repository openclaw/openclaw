import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as work from "./gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "./gateway-work-admission.test-helpers.js";

beforeEach(work.resetGatewayWorkAdmission);
afterEach(work.resetGatewayWorkAdmission);

const continuations = [
  { kind: "independent", runContinuation: work.runWithGatewayIndependentRootWorkContinuation },
  { kind: "detached", runContinuation: work.runWithGatewayDetachedWorkContinuation },
];
const continuationCases = <T>(values: readonly T[]) =>
  continuations.flatMap((entry) => values.map((value) => ({ ...entry, value })));

function suspend(phase?: "draining" | "prepared") {
  const lease = work.tryBeginGatewaySuspendAdmission(() => {});
  expect(lease).not.toBeNull();
  if (phase) {
    expect(phase === "draining" ? lease?.drain() : lease?.commit()).toBe(true);
  }
  return lease;
}

function expectRoots(count: number, holders?: string[]) {
  expect(work.getActiveGatewayRootWorkCount()).toBe(count);
  if (holders) {
    expect(work.getActiveGatewayRootWorkHolders()).toEqual(holders);
  }
}

function expectBlocked() {
  expect(work.isGatewayWorkAdmissionClosed()).toBe(true);
  expect(work.tryBeginGatewayRootWorkAdmission()).toBeNull();
}

function expectRootActivity(count: number, subordinateClosed: boolean) {
  expectRoots(count);
  expect(work.isGatewaySubordinateWorkAdmissionClosed()).toBe(subordinateClosed);
}

const restartMessage = "Gateway is restarting. Please try again shortly.";
const stopMessage = "Gateway is shutting down. Please try again once it is back online.";

it("publishes suspension transitions, rejects stale leases, and isolates observers", () => {
  const phases: string[] = [];
  const unsubscribeBroken = work.onGatewaySuspendAdmissionChange(() => {
    throw new Error("observer failed");
  });
  const unsubscribe = work.onGatewaySuspendAdmissionChange((phase) => phases.push(phase));
  const invalidated = vi.fn();
  try {
    const rolledBack = work.tryBeginGatewaySuspendAdmission(invalidated);
    expect(rolledBack?.rollback()).toBe(true);
    const suspension = work.tryBeginGatewaySuspendAdmission(invalidated);
    expect(suspension?.drain()).toBe(true);
    expect(rolledBack?.drain()).toBe(false);
    expect(rolledBack?.commit()).toBe(false);
    expect(rolledBack?.release()).toBe(false);
    expect(suspension?.rollback()).toBe(false);
    expect(suspension?.commit()).toBe(true);
    expect(suspension?.release()).toBe(true);
    expect(suspension?.release()).toBe(false);
    expect(invalidated).not.toHaveBeenCalled();
    expect(phases).toEqual("preparing accepting preparing draining prepared accepting".split(" "));
    expect(work.isGatewayWorkAdmissionClosed()).toBe(false);

    suspend()?.commit();
    work.markGatewayRestartDraining();
    expect(phases.at(-1)).toBe("accepting");
    expect(work.isGatewayWorkAdmissionClosed()).toBe(true);
    work.resetGatewayWorkAdmission();
    suspend()?.drain();
    work.resetGatewayWorkAdmission();
    expect(phases.at(-1)).toBe("accepting");
    unsubscribe();
    const published = phases.length;
    suspend()?.rollback();
    expect(phases).toHaveLength(published);
  } finally {
    unsubscribe();
    unsubscribeBroken();
  }
});

it.each(["stop (SIGTERM)", "restart (SIGUSR2)"] as const)(
  "preserves cancellation while stop supersedes %s refusals",
  async (first) => {
    const signal = work.getGatewayRestartDrainSignal();
    const cleanupSignal = work.getGatewayShutdownCleanupSignal();
    work.beginGatewayShutdownCleanup();
    expect(cleanupSignal.aborted).toBe(false);
    const aborted = vi.fn();
    signal.addEventListener("abort", aborted);
    work.markGatewayRestartDraining(first);
    expect(cleanupSignal.aborted).toBe(false);
    const originalReason = signal.reason;
    expect(originalReason).toMatchObject({
      name: "GatewayDrainingError",
      message: first.startsWith("stop") ? stopMessage : restartMessage,
    });
    work.markGatewayRestartDraining("stop (SIGINT)");
    work.markGatewayRestartDraining("restart");
    expectBlocked();
    expect(work.getGatewayRestartDrainSignal()).toBe(signal);
    expect(signal.reason).toBe(originalReason);
    expect(aborted).toHaveBeenCalledOnce();
    await expect(work.beginGatewayRootWorkAdmissionWhenOpen()).rejects.toThrow(stopMessage);
    await expect(work.runWithGatewayIndependentRootWorkAdmission(async () => {})).rejects.toThrow(
      stopMessage,
    );
    work.beginGatewayShutdownCleanup();
    expect(cleanupSignal.aborted).toBe(true);
    work.resetGatewayWorkAdmission();
    expect(work.getGatewayRestartDrainSignal()).not.toBe(signal);
    expect(work.getGatewayRestartDrainSignal().aborted).toBe(false);
    expect(work.getGatewayShutdownCleanupSignal().aborted).toBe(false);
  },
);

it("classifies draining errors only during an authoritative restart fence", () => {
  const error = new work.GatewayDrainingError();
  expect(work.isGatewayRestartDrainError(error)).toBe(false);
  const suspension = suspend();
  expect(work.isGatewayRestartDrainError(error)).toBe(false);
  expect(suspension?.rollback()).toBe(true);

  const signal = work.beginGatewayRestartSignalAdmission();
  expect(new work.GatewayDrainingError().message).toBe(restartMessage);
  expect(work.isGatewayRestartDrainError(error)).toBe(true);
  expect(work.isGatewayRestartDrainError(new Error("gateway is draining for restart"))).toBe(false);
  expect(signal?.rollback()).toBe(true);
  expect(new work.GatewayDrainingError().message).toBe(
    "Gateway is temporarily unavailable. Please try again shortly.",
  );
  expect(work.isGatewayRestartDrainError(error)).toBe(false);

  work.markGatewayRestartDraining();
  expect(work.isGatewayRestartDrainError(error)).toBe(true);
});

it.each([
  ["targeted", work.tryBeginGatewayPreparedRestartRootWorkAdmission],
  ["startup", work.tryBeginGatewayRestartStartupRootWorkAdmission],
] as const)("gates %s restart roots by suspension and restart phase", async (kind, begin) => {
  expect(begin()).toBeNull();
  const suspension = suspend();
  expect(begin()).toBeNull();
  expect(suspension?.commit()).toBe(true);
  if (kind === "targeted") {
    const root = begin();
    expect(root?.ownsRoot).toBe(true);
    expect(begin()).toBeNull();
    root?.release();
  }
  const suspendedSignal = work.beginGatewayRestartSignalAdmission();
  expect(suspendedSignal).not.toBeNull();
  expect(begin()).toBeNull();
  expect(suspendedSignal?.rollback()).toBe(true);
  expect(suspension?.release()).toBe(true);
  if (kind === "startup") {
    const signal = work.beginGatewayRestartSignalAdmission();
    const root = begin();
    expect(root?.ownsRoot).toBe(true);
    root?.release();
    expect(signal?.rollback()).toBe(true);
  }
  work.markGatewayRestartDraining();
  const root = begin();
  if (kind === "targeted") {
    expect(root).toBeNull();
  } else {
    expect(root?.ownsRoot).toBe(true);
    await root?.run(async () => expectRootActivity(1, true));
    root?.release();
  }
});
it.each(continuationCases(["suspended", "restarting"] as const))(
  "retains $kind ownership with a $value parent",
  async ({ runContinuation, value: fence }) => {
    const root = work.tryBeginGatewayRootWorkAdmission("ws:agent")!;
    expect(root).not.toBeNull();
    const finish = createDeferredCore();
    const entered = vi.fn();
    let continuation: Promise<void> | undefined;
    const launch = async () => {
      const suspension = fence === "suspended" ? suspend() : null;
      if (fence === "restarting") {
        work.markGatewayRestartDraining();
      }
      continuation = runContinuation(async () => {
        entered();
        await finish.promise;
      }, "runtime:detached");
      expectRoots(2, ["runtime:detached", "ws:agent"]);
      if (suspension) {
        expect(suspension.rollback()).toBe(true);
      }
    };
    try {
      await root.run(launch);
      root.release();
      expectRoots(1, ["runtime:detached"]);
      finish.resolve();
      await continuation;
      await nextTurn();
      expect(entered).toHaveBeenCalledOnce();
      expectRoots(0, []);
    } finally {
      finish.resolve();
      await continuation;
      root.release();
    }
  },
);

it.each([
  { kind: "admission", runDetached: work.runWithGatewayDetachedWorkAdmission },
  { kind: "continuation", runDetached: work.runWithGatewayDetachedWorkContinuation },
])(
  "retains detached $kind through descendant cleanup after its requester closes",
  async ({ runDetached }) => {
    const foreground = new AsyncWorkScope();
    const root = work.tryBeginGatewayRootWorkAdmission("foreground")!;
    const releaseChild = createDeferredCore();
    const handlerReturned = createDeferredCore();
    let child: Promise<string> | undefined;
    let track: ReturnType<typeof captureAsyncWorkTracker> | undefined;
    let backgroundSignal: AbortSignal | undefined;
    const settled = vi.fn();
    const run = async () => {
      track = captureAsyncWorkTracker();
      backgroundSignal = getAsyncWorkSignal();
      child = trackAsyncWork(async () => {
        await releaseChild.promise;
        return await trackAsyncWork(() => "tracked-after-close");
      });
      handlerReturned.resolve();
      return "completed";
    };
    const background = root.run(async () => foreground.run(() => runDetached(run, "background")));
    void background.then(settled);
    await handlerReturned.promise;
    root.release();
    const foregroundClosed = foreground.drain();
    try {
      await nextTurn();
      expect(settled).toHaveBeenCalledOnce();
      expect(backgroundSignal).not.toBe(foreground.signal);
      expect(backgroundSignal?.aborted).toBe(false);
      expect(work.getActiveGatewayRootWorkHolders()).toEqual(["background"]);
    } finally {
      releaseChild.resolve();
      await expect(child).resolves.toBe("tracked-after-close");
      await background;
      await foregroundClosed;
      await nextTurn();
    }
    expect(backgroundSignal?.aborted).toBe(true);
    await expect(track?.(() => {})).rejects.toThrow("Async work scope is closed");
    expectRoots(0);
  },
);

it.each(["resolve", "reject"] as const)("retains one root through effect %s", async (outcome) => {
  const release = createDeferredCore();
  const root = work.tryBeginGatewayRootWorkAdmission();
  const started = vi.fn();
  let effect: Promise<void> | undefined;
  try {
    await root?.run(async () => {
      effect = work.runWithRetainedGatewayRootWork(async () => {
        started();
        await release.promise;
        expect(work.isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
        if (outcome === "reject") {
          throw new Error("effect failed");
        }
      });
      void effect.catch(() => {});
      expect(started).toHaveBeenCalledOnce();
      expectRoots(1);
    });
    root?.release();
    root?.release();
    expectRoots(1);
    release.resolve();
    if (outcome === "reject") {
      await expect(effect).rejects.toThrow("effect failed");
    } else {
      await effect;
    }
    expectRoots(0);
  } finally {
    release.resolve();
    await effect?.catch(() => {});
    root?.release();
  }
});

it("does not park unrooted started effects behind suspension or restart admission", async () => {
  const suspension = suspend("prepared");
  const started = vi.fn(() => "finished");
  const completion = work.runWithRetainedGatewayRootWork(started);
  expect(started).toHaveBeenCalledOnce();
  await expect(completion).resolves.toBe("finished");
  suspension?.release();
  work.markGatewayRestartDraining();
  await expect(work.runWithRetainedGatewayRootWork(started)).resolves.toBe("finished");
  expectRoots(0);
});

it("synchronously transfers accepted events during drain without reopening admission", async () => {
  const root = work.tryBeginGatewayRootWorkAdmission();
  const scope = await root?.run(async () => work.retainGatewayRootWorkAdmissionContinuationScope());
  root?.release();
  work.markGatewayRestartDraining();
  const settle = createDeferredCore();
  let drain: Promise<void> | undefined;
  work.runOutsideGatewayRootWorkAdmission(() =>
    scope?.runSync(() => {
      drain = work.runWithGatewayDetachedWorkContinuation(() => settle.promise, "accepted-event");
    }),
  );
  scope?.release();
  scope?.release();
  expectRoots(1);
  expect(() => scope?.runSync(() => {})).toThrow("continuation is no longer active");
  expect(work.tryBeginGatewayRootWorkAdmission()).toBeNull();
  settle.resolve();
  await drain;
  expectRoots(0);
});

it.each(["before entry", "during execution"] as const)(
  "keeps borrowed and nested work owned until release %s",
  async (timing) => {
    const root = work.tryBeginGatewayRootWorkAdmission();
    const borrowed = await root?.run(async () =>
      work.captureGatewayRootWorkAdmissionContinuationScope(),
    );
    if (timing === "before entry") {
      root?.release();
      expectRoots(0);
      await expect(borrowed?.run(async () => {})).rejects.toThrow(
        "gateway root work continuation is no longer active",
      );
      borrowed?.release();
    } else {
      const suspension = suspend("draining");
      expect(work.tryBeginGatewayRootWorkAdmission()).toBeNull();
      await borrowed?.run(async () => {
        expect(work.getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(0);
        const subordinate = work.tryBeginGatewayRootWorkAdmission();
        expect(subordinate).toMatchObject({ ownsRoot: false });
        expectRoots(1);
        subordinate?.release();
        borrowed.release();
        root?.release();
        await Promise.resolve();
        expectRootActivity(1, false);
      });
      expectRoots(0);
      expect(suspension?.release()).toBe(true);
    }
  },
);

it("does not retire process-lifetime work with the request that started it", async () => {
  const childGate = createDeferredCore();
  let child: Promise<boolean> | undefined;

  await runWithGatewayRootWorkAdmissionForTest(async () => {
    child = work.runOutsideGatewayRootWorkAdmission(async () => {
      await childGate.promise;
      return work.isGatewaySubordinateWorkAdmissionClosed();
    });
  });

  childGate.resolve();
  await expect(child).resolves.toBe(false);
});

it.each(["settled", "reset"] as const)(
  "observes final root release once without retaining it (%s)",
  async (reason) => {
    expect(work.captureGatewayRootWorkReleaseObserver()).toBeNull();
    const root = work.tryBeginGatewayRootWorkAdmission()!;
    const { observe, retained } = await root.run(async () => ({
      observe: work.captureGatewayRootWorkReleaseObserver()!,
      retained: work.retainGatewayRootWorkAdmissionContinuationScope()!,
    }));
    const released = vi.fn();
    const removed = vi.fn();
    observe(() => {
      throw new Error("synthetic observer failure");
    });
    const stop = observe(released);
    observe(removed)();
    root.release();
    expect(released).not.toHaveBeenCalled();
    await retained.run(async () => {
      retained.release();
      expect(released).not.toHaveBeenCalled();
      expectRoots(1);
      if (reason === "reset") {
        work.resetGatewayWorkAdmission();
      }
    });
    expectRoots(0);
    expect(released).toHaveBeenCalledExactlyOnceWith(reason);
    expect(removed).not.toHaveBeenCalled();
    root.release();
    retained.release();
    work.resetGatewayWorkAdmission();
    stop();
    expect(released).toHaveBeenCalledOnce();
    const late = vi.fn();
    observe(late);
    expect(late).toHaveBeenCalledExactlyOnceWith(reason);
  },
);

it.each(continuationCases([false, true]))(
  "blocks providers during restart ($kind, reserved=$value)",
  async ({ runContinuation, value: reserved }) => {
    const gate = createDeferredCore();
    const providerStarted = vi.fn();
    const run = vi.fn(async () => {
      await gate.promise;
      if (work.isGatewaySubordinateWorkAdmissionClosed()) {
        throw new work.GatewayDrainingError();
      }
      providerStarted();
    });
    let continuation: Promise<void> | undefined;
    if (reserved) {
      await runWithGatewayRootWorkAdmissionForTest(async () => {
        continuation = runContinuation(run);
      });
    }
    work.markGatewayRestartDraining();
    continuation ??= runContinuation(run);
    gate.resolve();
    await expect(continuation).rejects.toBeInstanceOf(work.GatewayDrainingError);
    expect(providerStarted).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(reserved ? 1 : 0);
    await nextTurn();
    expectRoots(0);
  },
);

it.each([
  { fence: "signal", outcome: "rollback" },
  { fence: "signal", outcome: "orphan" },
  { fence: "signal", outcome: "drain" },
  { fence: "suspend", outcome: "rollback" },
  { fence: "suspend", outcome: "drain" },
] as const)("settles waiting roots after $fence $outcome", async ({ fence, outcome }) => {
  const signal = fence === "signal" ? work.beginGatewayRestartSignalAdmission() : null;
  const suspension = fence === "suspend" ? suspend("prepared") : null;
  if (fence === "signal") {
    expect(signal).not.toBeNull();
  }
  expect(work.tryBeginGatewaySuspendAdmission(() => {})).toBeNull();
  if (signal) {
    expect(work.beginGatewayRestartSignalAdmission()).toBeNull();
  }
  const entered = vi.fn(async () => expectRoots(1));
  const waiting =
    fence === "signal"
      ? work.beginGatewayRootWorkAdmissionWhenOpen()
      : runWithGatewayRootWorkAdmissionForTest(entered);
  const resolved = vi.fn();
  void waiting.then(resolved, () => {});
  await Promise.resolve();
  expect(resolved).not.toHaveBeenCalled();
  expect(entered).not.toHaveBeenCalled();
  if (outcome === "drain") {
    work.markGatewayRestartDraining();
    expect(signal?.rollback() ?? suspension?.release()).toBe(false);
    await expect(waiting).rejects.toBeInstanceOf(work.GatewayDrainingError);
  } else {
    if (outcome === "orphan") {
      expect(work.rollbackGatewayRestartSignalFence()).toBe(true);
      expect(signal?.rollback()).toBe(false);
    } else {
      expect(signal?.rollback() ?? suspension?.release()).toBe(true);
    }
    const admission = await waiting;
    expect(resolved).toHaveBeenCalledOnce();
    if (admission) {
      expect(admission.ownsRoot).toBe(true);
      admission.release();
    } else {
      expect(entered).toHaveBeenCalledOnce();
    }
    expectRoots(0);
    expect(work.tryBeginGatewaySuspendAdmission(() => {})?.rollback()).toBe(true);
  }
});

it.each(["before admission", "while suspended", "during resume", "after start"] as const)(
  "cancels admission %s without retiring started work",
  async (timing) => {
    const controller = new AbortController();
    const suspension = timing === "before admission" ? null : suspend("prepared");
    const started = createDeferredCore();
    const release = createDeferredCore();
    if (timing === "before admission") {
      controller.abort();
    }
    const run = vi.fn(async () => {
      started.resolve();
      await release.promise;
    });
    const settled = vi.fn();
    const rejected = vi.fn();
    const completion = work
      .runWithGatewayIndependentRootWorkAdmission(run, "test:cancellable", controller.signal)
      .then(settled, rejected);
    try {
      if (timing === "during resume" || timing === "after start") {
        suspension?.release();
      }
      if (timing === "after start") {
        await started.promise;
      }
      controller.abort();
      await nextTurn();
      if (timing === "after start") {
        expect(settled).not.toHaveBeenCalled();
        expect(rejected).not.toHaveBeenCalled();
        expectRoots(1);
      } else {
        expect.soft(rejected, "cancellation settles before resume").toHaveBeenCalledOnce();
        expect(run).not.toHaveBeenCalled();
      }
    } finally {
      suspension?.release();
      release.resolve();
      await completion;
    }
    if (timing === "after start") {
      expect(settled).toHaveBeenCalledOnce();
    } else {
      expect(rejected).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: "AbortError" }),
      );
      expect(run).not.toHaveBeenCalled();
    }
    expectRoots(0);
  },
);

it("retires surviving root records across an in-process reset", async () => {
  const root = work.tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  await root?.run(async () => {
    work.resetGatewayWorkAdmission();
    expectRootActivity(0, true);
    const nested = work.tryBeginGatewayRootWorkAdmission();
    expect(nested).toMatchObject({ ownsRoot: true });
    await nested?.run(async () => {
      expectRootActivity(1, false);
    });
    nested?.release();
    expect(work.isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
  });
  root?.release();
  expectRoots(0);
});
