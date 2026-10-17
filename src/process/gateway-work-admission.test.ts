import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  beginGatewayRestartSignalAdmission,
  beginGatewayRootWorkAdmissionWhenOpen,
  beginGatewayShutdownCleanup,
  captureGatewayRootWorkAdmissionContinuationScope,
  captureGatewayRootWorkReleaseObserver,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  getGatewayRestartDrainSignal,
  getGatewayShutdownCleanupSignal,
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDrainError,
  isGatewaySubordinateWorkAdmissionClosed,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  onGatewaySuspendAdmissionChange,
  retainGatewayRootWorkAdmissionContinuationScope,
  resetGatewayWorkAdmission,
  rollbackGatewayRestartSignalFence,
  runWithGatewayDetachedWorkAdmission,
  runWithGatewayDetachedWorkContinuation,
  runWithGatewayIndependentRootWorkAdmission,
  runWithGatewayIndependentRootWorkContinuation,
  runWithRetainedGatewayRootWork,
  runOutsideGatewayRootWorkAdmission,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRestartStartupRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "./gateway-work-admission.test-helpers.js";

beforeEach(resetGatewayWorkAdmission);
afterEach(resetGatewayWorkAdmission);

const continuations = [
  { kind: "independent", runContinuation: runWithGatewayIndependentRootWorkContinuation },
  { kind: "detached", runContinuation: runWithGatewayDetachedWorkContinuation },
];
const continuationCases = <T>(values: readonly T[]) =>
  continuations.flatMap((entry) => values.map((value) => ({ ...entry, value })));

function suspend(phase?: "draining" | "prepared") {
  const lease = tryBeginGatewaySuspendAdmission(() => {});
  expect(lease).not.toBeNull();
  if (phase) {
    expect(phase === "draining" ? lease?.drain() : lease?.commit()).toBe(true);
  }
  return lease;
}

function expectRoots(count: number, holders?: string[]) {
  expect(getActiveGatewayRootWorkCount()).toBe(count);
  if (holders) {
    expect(getActiveGatewayRootWorkHolders()).toEqual(holders);
  }
}

function expectBlocked() {
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
}

function expectRootActivity(count: number, subordinateClosed: boolean) {
  expectRoots(count);
  expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(subordinateClosed);
}

const restartMessage = "Gateway is restarting. Please try again shortly.";
const stopMessage = "Gateway is shutting down. Please try again once it is back online.";

it("publishes only committed suspension transitions and isolates broken observers", () => {
  const phases: string[] = [];
  const unsubscribeBroken = onGatewaySuspendAdmissionChange(() => {
    throw new Error("observer failed");
  });
  const unsubscribe = onGatewaySuspendAdmissionChange((phase) => phases.push(phase));
  const invalidated = vi.fn();
  try {
    const rolledBack = tryBeginGatewaySuspendAdmission(invalidated);
    expect(rolledBack?.rollback()).toBe(true);
    const suspension = tryBeginGatewaySuspendAdmission(invalidated);
    expect(suspension?.drain()).toBe(true);
    expect(suspension?.commit()).toBe(true);
    expect(suspension?.release()).toBe(true);
    expect(suspension?.release()).toBe(false);
    expect(invalidated).not.toHaveBeenCalled();
    expect(phases).toEqual("preparing accepting preparing draining prepared accepting".split(" "));
    expect(isGatewayWorkAdmissionClosed()).toBe(false);

    suspend()?.commit();
    markGatewayRestartDraining();
    expect(phases.at(-1)).toBe("accepting");
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
    resetGatewayWorkAdmission();
    suspend()?.drain();
    resetGatewayWorkAdmission();
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
    const signal = getGatewayRestartDrainSignal();
    const cleanupSignal = getGatewayShutdownCleanupSignal();
    beginGatewayShutdownCleanup();
    expect(cleanupSignal.aborted).toBe(false);
    const aborted = vi.fn();
    signal.addEventListener("abort", aborted);
    markGatewayRestartDraining(first);
    expect(cleanupSignal.aborted).toBe(false);
    const originalReason = signal.reason;
    expect(originalReason).toMatchObject({
      name: "GatewayDrainingError",
      message: first.startsWith("stop") ? stopMessage : restartMessage,
    });
    markGatewayRestartDraining("stop (SIGINT)");
    markGatewayRestartDraining("restart");
    expectBlocked();
    expect(getGatewayRestartDrainSignal()).toBe(signal);
    expect(signal.reason).toBe(originalReason);
    expect(aborted).toHaveBeenCalledOnce();
    await expect(beginGatewayRootWorkAdmissionWhenOpen()).rejects.toThrow(stopMessage);
    await expect(runWithGatewayIndependentRootWorkAdmission(async () => {})).rejects.toThrow(
      stopMessage,
    );
    beginGatewayShutdownCleanup();
    expect(cleanupSignal.aborted).toBe(true);
    resetGatewayWorkAdmission();
    expect(getGatewayRestartDrainSignal().aborted).toBe(false);
    expect(getGatewayShutdownCleanupSignal().aborted).toBe(false);
  },
);

it("classifies draining errors only during an authoritative restart fence", () => {
  const error = new GatewayDrainingError();
  const firstDrainSignal = getGatewayRestartDrainSignal();

  expect(isGatewayRestartDrainError(error)).toBe(false);
  expect(isGatewayRestartDrainError(new Error("GatewayDrainingError"))).toBe(false);

  const suspension = suspend();
  expect(isGatewayRestartDrainError(error)).toBe(false);
  expect(suspension?.rollback()).toBe(true);

  const signal = beginGatewayRestartSignalAdmission();
  expect(new GatewayDrainingError().message).toBe(restartMessage);
  expect(isGatewayRestartDrainError(error)).toBe(true);
  expect(isGatewayRestartDrainError(new Error("gateway is draining for restart"))).toBe(false);
  expect(signal?.rollback()).toBe(true);
  expect(new GatewayDrainingError().message).toBe(
    "Gateway is temporarily unavailable. Please try again shortly.",
  );
  expect(isGatewayRestartDrainError(error)).toBe(false);

  markGatewayRestartDraining();
  expect(isGatewayRestartDrainError(error)).toBe(true);
  expect(firstDrainSignal.aborted).toBe(true);

  resetGatewayWorkAdmission();
  const nextDrainSignal = getGatewayRestartDrainSignal();
  expect(nextDrainSignal).not.toBe(firstDrainSignal);
  expect(nextDrainSignal.aborted).toBe(false);
  markGatewayRestartDraining();
  expect(nextDrainSignal.aborted).toBe(true);
});

it("drains already-admitted work before promoting the same generation to prepared", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).toMatchObject({ ownsRoot: true });
  expect(getGatewaySuspendAdmissionPhase()).toBe("accepting");

  const suspension = suspend();
  expect(getGatewaySuspendAdmissionPhase()).toBe("preparing");
  expect(suspension?.drain()).toBe(true);
  expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();

  await root?.run(async () => {
    expectRootActivity(1, false);
    expect(getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(0);
    const subordinate = tryBeginGatewayRootWorkAdmission();
    expect(subordinate).toMatchObject({ ownsRoot: false });
    expectRoots(1);
    subordinate?.release();
    await runWithGatewayIndependentRootWorkContinuation(async () => {
      expectRootActivity(2, false);
    });
  });
  root?.release();

  expect(suspension?.commit()).toBe(true);
  expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
  const targetedRestart = tryBeginGatewayPreparedRestartRootWorkAdmission();
  expect(targetedRestart?.ownsRoot).toBe(true);
  targetedRestart?.release();
  expect(suspension?.release()).toBe(true);
  expect(getGatewaySuspendAdmissionPhase()).toBe("accepting");
});

it("releases draining admission without allowing stale generations to reopen it", () => {
  const first = suspend("draining");
  expect(first?.rollback()).toBe(false);
  expect(first?.release()).toBe(true);

  const second = suspend("draining");
  expect(first?.drain()).toBe(false);
  expect(first?.commit()).toBe(false);
  expect(first?.release()).toBe(false);
  expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
  expect(second?.release()).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});

it("admits a targeted restart root only from prepared suspension", () => {
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();

  const suspension = suspend();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
  expect(suspension?.commit()).toBe(true);

  const restartRoot = tryBeginGatewayPreparedRestartRootWorkAdmission();
  expect(restartRoot?.ownsRoot).toBe(true);
  expectRoots(1);
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
  restartRoot?.release();
  expectRoots(0);
  expect(suspension?.release()).toBe(true);

  const prepared = suspend("prepared");
  const pendingSignal = beginGatewayRestartSignalAdmission();
  expect(pendingSignal).not.toBeNull();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
  expect(pendingSignal?.rollback()).toBe(true);
  expect(prepared?.release()).toBe(true);

  markGatewayRestartDraining();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
});

it("admits a tracked restart-startup root only while restart fencing accepts recovery", async () => {
  expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();

  const suspension = suspend();
  expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();
  expect(suspension?.commit()).toBe(true);
  const suspendedSignal = beginGatewayRestartSignalAdmission();
  expect(suspendedSignal).not.toBeNull();
  expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();
  expect(suspendedSignal?.rollback()).toBe(true);
  expect(suspension?.release()).toBe(true);

  const signal = beginGatewayRestartSignalAdmission();
  const signalRoot = tryBeginGatewayRestartStartupRootWorkAdmission();
  expect(signalRoot?.ownsRoot).toBe(true);
  await signalRoot?.run(async () => {
    expectRoots(1);
    expect(getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(0);
  });
  signalRoot?.release();
  expectRoots(0);
  expect(signal?.rollback()).toBe(true);

  markGatewayRestartDraining();
  const restartRoot = tryBeginGatewayRestartStartupRootWorkAdmission();
  expect(restartRoot?.ownsRoot).toBe(true);
  await restartRoot?.run(async () => {
    expectRootActivity(1, true);
    resetGatewayWorkAdmission();
    expectRootActivity(0, true);
    expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();
  });
  restartRoot?.release();
  expectRoots(0);
});

it.each(continuationCases(["unrooted", "suspended", "restarting"] as const))(
  "retains $kind ownership with a $value parent",
  async ({ runContinuation, value: fence }) => {
    const root = fence === "unrooted" ? null : tryBeginGatewayRootWorkAdmission("ws:agent");
    if (fence !== "unrooted") {
      expect(root).not.toBeNull();
    }
    const finish = createDeferredCore();
    const entered = vi.fn();
    let continuation: Promise<void> | undefined;
    const launch = async () => {
      const suspension = fence === "suspended" ? suspend() : null;
      if (fence === "restarting") {
        markGatewayRestartDraining();
      }
      continuation = runContinuation(async () => {
        entered();
        await finish.promise;
      }, "runtime:detached");
      expectRoots(root ? 2 : 1, root ? ["runtime:detached", "ws:agent"] : ["runtime:detached"]);
      if (suspension) {
        expect(suspension.rollback()).toBe(true);
      }
    };
    try {
      if (root) {
        await root.run(launch);
      } else {
        await launch();
      }
      root?.release();
      expectRoots(1, ["runtime:detached"]);
      finish.resolve();
      await continuation;
      await nextTurn();
      expect(entered).toHaveBeenCalledOnce();
      expectRoots(0, []);
    } finally {
      finish.resolve();
      await continuation;
      root?.release();
    }
  },
);

it.each([
  { kind: "admission", runDetached: runWithGatewayDetachedWorkAdmission },
  { kind: "continuation", runDetached: runWithGatewayDetachedWorkContinuation },
])(
  "retains detached $kind through descendant cleanup after its requester closes",
  async ({ runDetached }) => {
    const foreground = new AsyncWorkScope();
    const root = tryBeginGatewayRootWorkAdmission("foreground")!;
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
        await trackAsyncWork(() => {});
        return "tracked-after-close";
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
      expect(backgroundSignal).toBeDefined();
      expect(backgroundSignal).not.toBe(foreground.signal);
      expect(backgroundSignal?.aborted).toBe(false);
      expect(getActiveGatewayRootWorkHolders()).toEqual(["background"]);
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
  const root = tryBeginGatewayRootWorkAdmission();
  const started = vi.fn();
  let effect: Promise<void> | undefined;
  try {
    await root?.run(async () => {
      effect = runWithRetainedGatewayRootWork(async () => {
        started();
        await release.promise;
        expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
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
  const completion = runWithRetainedGatewayRootWork(started);
  expect(started).toHaveBeenCalledOnce();
  await expect(completion).resolves.toBe("finished");
  expectRoots(0);
  suspension?.release();
  markGatewayRestartDraining();
  await expect(runWithRetainedGatewayRootWork(started)).resolves.toBe("finished");
  expectRoots(0);
});

it("synchronously transfers accepted events during drain without reopening admission", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  const scope = await root?.run(async () => retainGatewayRootWorkAdmissionContinuationScope());
  root?.release();
  markGatewayRestartDraining();
  const settle = createDeferredCore();
  let drain: Promise<void> | undefined;
  runOutsideGatewayRootWorkAdmission(() =>
    scope?.runSync(() => {
      drain = runWithGatewayDetachedWorkContinuation(() => settle.promise, "accepted-event");
    }),
  );
  scope?.release();
  scope?.release();
  expectRoots(1);
  expect(() => scope?.runSync(() => {})).toThrow("continuation is no longer active");
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  settle.resolve();
  await drain;
  expectRoots(0);
});

it.each(["before entry", "during execution"] as const)(
  "borrows ownership until release %s",
  async (timing) => {
    const root = tryBeginGatewayRootWorkAdmission();
    const borrowed = await root?.run(async () =>
      captureGatewayRootWorkAdmissionContinuationScope(),
    );
    expectRoots(1);
    if (timing === "before entry") {
      root?.release();
      expectRoots(0);
      await expect(borrowed?.run(async () => {})).rejects.toThrow(
        "gateway root work continuation is no longer active",
      );
      borrowed?.release();
    } else {
      const suspension = suspend("draining");
      await borrowed?.run(async () => {
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
    child = runOutsideGatewayRootWorkAdmission(async () => {
      await childGate.promise;
      return isGatewaySubordinateWorkAdmissionClosed();
    });
  });

  childGate.resolve();
  await expect(child).resolves.toBe(false);
});

it.each(["settled", "reset"] as const)(
  "observes final root release once without retaining it (%s)",
  async (reason) => {
    expect(captureGatewayRootWorkReleaseObserver()).toBeNull();
    const root = tryBeginGatewayRootWorkAdmission()!;
    const { observe, retained } = await root.run(async () => ({
      observe: captureGatewayRootWorkReleaseObserver()!,
      retained: retainGatewayRootWorkAdmissionContinuationScope()!,
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
        resetGatewayWorkAdmission();
      }
    });
    expectRoots(0);
    expect(released).toHaveBeenCalledExactlyOnceWith(reason);
    expect(removed).not.toHaveBeenCalled();
    root.release();
    retained.release();
    resetGatewayWorkAdmission();
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
      if (isGatewaySubordinateWorkAdmissionClosed()) {
        throw new GatewayDrainingError();
      }
      providerStarted();
    });
    let continuation: Promise<void> | undefined;
    if (reserved) {
      await runWithGatewayRootWorkAdmissionForTest(async () => {
        continuation = runContinuation(run);
      });
      expectRoots(1);
    }
    markGatewayRestartDraining();
    continuation ??= runContinuation(run);
    gate.resolve();
    await expect(continuation).rejects.toThrow(restartMessage);
    await expect(continuation).rejects.toBeInstanceOf(GatewayDrainingError);
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
  const signal = fence === "signal" ? beginGatewayRestartSignalAdmission() : null;
  const suspension = fence === "suspend" ? suspend("prepared") : null;
  if (fence === "signal") {
    expect(signal).not.toBeNull();
  }
  expectBlocked();
  expect(tryBeginGatewaySuspendAdmission(() => {})).toBeNull();
  if (signal) {
    expect(beginGatewayRestartSignalAdmission()).toBeNull();
  }
  const entered = vi.fn();
  const waiting =
    fence === "signal"
      ? beginGatewayRootWorkAdmissionWhenOpen()
      : runWithGatewayRootWorkAdmissionForTest(async () => {
          entered();
          expectRoots(1);
        });
  let resolved = false;
  void waiting.then(
    () => {
      resolved = true;
    },
    () => {},
  );
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(entered).not.toHaveBeenCalled();
  if (outcome === "drain") {
    markGatewayRestartDraining();
    expect(signal?.rollback() ?? suspension?.release()).toBe(false);
    await expect(waiting).rejects.toBeInstanceOf(GatewayDrainingError);
    expect(entered).not.toHaveBeenCalled();
    expectBlocked();
  } else {
    if (outcome === "orphan") {
      expect(rollbackGatewayRestartSignalFence()).toBe(true);
      expect(signal?.rollback()).toBe(false);
    } else {
      expect(signal?.rollback() ?? suspension?.release()).toBe(true);
    }
    const admission = await waiting;
    expect(Boolean(admission)).toBe(fence === "signal");
    expect(resolved).toBe(true);
    if (admission) {
      expect(admission.ownsRoot).toBe(true);
      admission.release();
    } else {
      expect(entered).toHaveBeenCalledOnce();
    }
    expectRoots(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(tryBeginGatewaySuspendAdmission(() => {})?.rollback()).toBe(true);
  }
});

it.each(["before admission", "while suspended", "during resume"] as const)(
  "retires independent work cancelled %s without running it after resume",
  async (timing) => {
    const controller = new AbortController();
    const suspension = timing === "before admission" ? null : suspend("prepared");
    if (timing === "before admission") {
      controller.abort();
    }
    const run = vi.fn(async () => {});
    const resolved = vi.fn();
    const rejected = vi.fn();
    const completion = runWithGatewayIndependentRootWorkAdmission(
      run,
      "test:cancellable",
      controller.signal,
    ).then(resolved, rejected);
    try {
      if (timing === "during resume") {
        suspension?.release();
      }
      controller.abort();
      await nextTurn();
      expect
        .soft(rejected, "cancellation does not wait for suspension release")
        .toHaveBeenCalledOnce();
    } finally {
      suspension?.release();
      await completion;
    }
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "AbortError" }),
    );
    expect(resolved).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expectRoots(0);
  },
);

it("retains resumed independent work until its original completion after admission cancellation", async () => {
  const controller = new AbortController();
  const suspension = suspend("prepared");
  const started = createDeferredCore();
  const release = createDeferredCore();
  const settled = vi.fn();
  const execution = runWithGatewayIndependentRootWorkAdmission(
    async () => {
      started.resolve();
      await release.promise;
    },
    "test:cancellable",
    controller.signal,
  ).then(settled);
  try {
    suspension?.release();
    await started.promise;
    controller.abort();
    await nextTurn();
    expect(settled).not.toHaveBeenCalled();
    expectRoots(1);
  } finally {
    suspension?.release();
    release.resolve();
    await execution;
  }
  expect(settled).toHaveBeenCalledOnce();
  expectRoots(0);
});

it("retires surviving root records across an in-process reset", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  await root?.run(async () => {
    resetGatewayWorkAdmission();
    expectRootActivity(0, true);
    const nested = tryBeginGatewayRootWorkAdmission();
    expect(nested).toMatchObject({ ownsRoot: true });
    await nested?.run(async () => {
      expectRootActivity(1, false);
    });
    nested?.release();
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
  });
  root?.release();
  expectRoots(0);
});
