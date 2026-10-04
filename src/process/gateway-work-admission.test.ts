// Covers root work counting and reversible suspension admission transitions.
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
  captureGatewayRootWorkAdmissionContinuationScope,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  getGatewayRestartDrainSignal,
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
    expect(phases).toEqual([
      "preparing",
      "accepting",
      "preparing",
      "draining",
      "prepared",
      "accepting",
    ]);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);

    tryBeginGatewaySuspendAdmission(() => {})?.commit();
    markGatewayRestartDraining();
    expect(phases.at(-1)).toBe("accepting");
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
    resetGatewayWorkAdmission();
    tryBeginGatewaySuspendAdmission(() => {})?.drain();
    resetGatewayWorkAdmission();
    expect(phases.at(-1)).toBe("accepting");
    unsubscribe();
    const published = phases.length;
    tryBeginGatewaySuspendAdmission(() => {})?.rollback();
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
    const aborted = vi.fn();
    signal.addEventListener("abort", aborted);
    markGatewayRestartDraining(first);
    const originalReason = signal.reason;
    expect(originalReason).toMatchObject({
      name: "GatewayDrainingError",
      message: first.startsWith("stop")
        ? "Gateway is shutting down. Please try again once it is back online."
        : "Gateway is restarting. Please try again shortly.",
    });
    markGatewayRestartDraining("stop (SIGINT)");
    markGatewayRestartDraining("restart");
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    expect(getGatewayRestartDrainSignal()).toBe(signal);
    expect(signal.reason).toBe(originalReason);
    expect(aborted).toHaveBeenCalledOnce();
    const message = "Gateway is shutting down. Please try again once it is back online.";
    await expect(beginGatewayRootWorkAdmissionWhenOpen()).rejects.toThrow(message);
    await expect(runWithGatewayIndependentRootWorkAdmission(async () => {})).rejects.toThrow(
      message,
    );
    resetGatewayWorkAdmission();
    expect(getGatewayRestartDrainSignal().aborted).toBe(false);
  },
);

it("classifies draining errors only while an authoritative restart signal or drain is active", () => {
  const error = new GatewayDrainingError();
  const firstDrainSignal = getGatewayRestartDrainSignal();

  expect(isGatewayRestartDrainError(error)).toBe(false);
  expect(isGatewayRestartDrainError(new Error("GatewayDrainingError"))).toBe(false);

  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(isGatewayRestartDrainError(error)).toBe(false);
  expect(suspension?.rollback()).toBe(true);

  const signal = beginGatewayRestartSignalAdmission();
  expect(new GatewayDrainingError().message).toBe(
    "Gateway is restarting. Please try again shortly.",
  );
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
  expect(root).not.toBeNull();
  expect(root?.ownsRoot).toBe(true);
  expect(getGatewaySuspendAdmissionPhase()).toBe("accepting");

  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(getGatewaySuspendAdmissionPhase()).toBe("preparing");
  expect(suspension?.drain()).toBe(true);
  expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();

  await root?.run(async () => {
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(0);
    const subordinate = tryBeginGatewayRootWorkAdmission();
    expect(subordinate).not.toBeNull();
    expect(subordinate?.ownsRoot).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    subordinate?.release();
    await runWithGatewayIndependentRootWorkContinuation(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
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
  const first = tryBeginGatewaySuspendAdmission(() => {});
  expect(first?.drain()).toBe(true);
  expect(first?.rollback()).toBe(false);
  expect(first?.release()).toBe(true);

  const second = tryBeginGatewaySuspendAdmission(() => {});
  expect(second?.drain()).toBe(true);
  expect(first?.drain()).toBe(false);
  expect(first?.commit()).toBe(false);
  expect(first?.release()).toBe(false);
  expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
  expect(second?.release()).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});

it("admits a targeted restart root only from prepared suspension", () => {
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();

  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension).not.toBeNull();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
  expect(suspension?.commit()).toBe(true);

  const restartRoot = tryBeginGatewayPreparedRestartRootWorkAdmission();
  expect(restartRoot?.ownsRoot).toBe(true);
  expect(getActiveGatewayRootWorkCount()).toBe(1);
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
  restartRoot?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(suspension?.release()).toBe(true);

  const prepared = tryBeginGatewaySuspendAdmission(() => {});
  expect(prepared?.commit()).toBe(true);
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

  const suspension = tryBeginGatewaySuspendAdmission(() => {});
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
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(0);
  });
  signalRoot?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(signal?.rollback()).toBe(true);

  markGatewayRestartDraining();
  const restartRoot = tryBeginGatewayRestartStartupRootWorkAdmission();
  expect(restartRoot?.ownsRoot).toBe(true);
  await restartRoot?.run(async () => {
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
    resetGatewayWorkAdmission();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
    expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();
  });
  restartRoot?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it.each(
  continuations.flatMap((entry) =>
    (["unrooted", "suspended", "restarting"] as const).map((fence) => ({
      kind: entry.kind,
      runContinuation: entry.runContinuation,
      fence,
    })),
  ),
)(
  "retains $kind continuation ownership with a $fence parent",
  async ({ runContinuation, fence }) => {
    const root = fence === "unrooted" ? null : tryBeginGatewayRootWorkAdmission("ws:agent");
    if (fence !== "unrooted") {
      expect(root).not.toBeNull();
    }
    const finish = createDeferredCore();
    const entered = vi.fn();
    let continuation: Promise<void> | undefined;
    const launch = async () => {
      const suspension = fence === "suspended" ? tryBeginGatewaySuspendAdmission(() => {}) : null;
      if (fence === "suspended") {
        expect(suspension).not.toBeNull();
      }
      if (fence === "restarting") {
        markGatewayRestartDraining();
      }
      continuation = runContinuation(async () => {
        entered();
        await finish.promise;
      }, "runtime:detached");
      expect(getActiveGatewayRootWorkCount()).toBe(root ? 2 : 1);
      expect(getActiveGatewayRootWorkHolders()).toEqual(
        root ? ["runtime:detached", "ws:agent"] : ["runtime:detached"],
      );
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
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(getActiveGatewayRootWorkHolders()).toEqual(["runtime:detached"]);
      finish.resolve();
      await continuation;
      await nextTurn();
      expect(entered).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(getActiveGatewayRootWorkHolders()).toEqual([]);
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
    let settled = false;
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
    void background.then(() => {
      settled = true;
    });
    await handlerReturned.promise;
    root.release();
    const foregroundClosed = foreground.drain();
    try {
      await nextTurn();
      expect(settled).toBe(true);
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
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  },
);

it.each(["resolve", "reject"] as const)(
  "retains the original root through a started effect's %s without adding admission",
  async (outcome) => {
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
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      });
      root?.release();
      root?.release();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      release.resolve();
      if (outcome === "reject") {
        await expect(effect).rejects.toThrow("effect failed");
      } else {
        await effect;
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      release.resolve();
      await effect?.catch(() => {});
      root?.release();
    }
  },
);

it("does not park unrooted started effects behind suspension or restart admission", async () => {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const started = vi.fn(() => "finished");
  const suspended = runWithRetainedGatewayRootWork(started);
  try {
    expect(started).toHaveBeenCalledOnce();
    await expect(suspended).resolves.toBe("finished");
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  } finally {
    suspension?.release();
    await suspended;
  }
  markGatewayRestartDraining();
  await expect(runWithRetainedGatewayRootWork(started)).resolves.toBe("finished");
  expect(getActiveGatewayRootWorkCount()).toBe(0);
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
  expect(getActiveGatewayRootWorkCount()).toBe(1);
  expect(() => scope?.runSync(() => {})).toThrow("continuation is no longer active");
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  settle.resolve();
  await drain;
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it.each(["before entry", "during execution"] as const)(
  "retains borrowed ownership only during execution (release %s)",
  async (timing) => {
    const root = tryBeginGatewayRootWorkAdmission();
    const borrowed = await root?.run(async () =>
      captureGatewayRootWorkAdmissionContinuationScope(),
    );
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    if (timing === "before entry") {
      root?.release();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await expect(borrowed?.run(async () => {})).rejects.toThrow(
        "gateway root work continuation is no longer active",
      );
      borrowed?.release();
    } else {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      await borrowed?.run(async () => {
        borrowed.release();
        root?.release();
        await Promise.resolve();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
      });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(suspension?.release()).toBe(true);
    }
  },
);

it("does not retire process-lifetime work with the request that started it", async () => {
  let releaseChild = () => {};
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let child: Promise<boolean> | undefined;

  await runWithGatewayRootWorkAdmissionForTest(async () => {
    child = runOutsideGatewayRootWorkAdmission(async () => {
      await childGate;
      return isGatewaySubordinateWorkAdmissionClosed();
    });
  });

  releaseChild();
  await expect(child).resolves.toBe(false);
});

it.each(
  continuations.flatMap((entry) =>
    [false, true].map((reserved) => ({
      kind: entry.kind,
      runContinuation: entry.runContinuation,
      reserved,
    })),
  ),
)(
  "blocks provider execution during restart ($kind, reserved=$reserved)",
  async ({ runContinuation, reserved }) => {
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
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    }
    markGatewayRestartDraining();
    continuation ??= runContinuation(run);
    gate.resolve();
    await expect(continuation).rejects.toThrow("Gateway is restarting. Please try again shortly.");
    await expect(continuation).rejects.toBeInstanceOf(GatewayDrainingError);
    expect(providerStarted).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(reserved ? 1 : 0);
    await nextTurn();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  },
);

it("does not let a stale suspension release clear restart drain", () => {
  const invalidated = vi.fn();
  const suspension = tryBeginGatewaySuspendAdmission(invalidated);
  expect(suspension?.commit()).toBe(true);

  markGatewayRestartDraining();

  expect(invalidated).toHaveBeenCalledOnce();
  expect(suspension?.release()).toBe(false);
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
});

it.each([
  { fence: "signal", outcome: "rollback" },
  { fence: "signal", outcome: "orphan" },
  { fence: "signal", outcome: "drain" },
  { fence: "suspend", outcome: "rollback" },
  { fence: "suspend", outcome: "drain" },
] as const)("settles waiting roots after $fence $outcome", async ({ fence, outcome }) => {
  const signal = fence === "signal" ? beginGatewayRestartSignalAdmission() : null;
  const suspension = fence === "suspend" ? tryBeginGatewaySuspendAdmission(() => {}) : null;
  if (fence === "signal") {
    expect(signal).not.toBeNull();
  }
  if (suspension) {
    expect(suspension.commit()).toBe(true);
  }
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
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
          expect(getActiveGatewayRootWorkCount()).toBe(1);
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
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
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
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(tryBeginGatewaySuspendAdmission(() => {})?.rollback()).toBe(true);
  }
});

it.each(["before admission", "while suspended", "during resume"] as const)(
  "retires independent work cancelled %s without running it after resume",
  async (timing) => {
    const controller = new AbortController();
    const suspension =
      timing === "before admission" ? null : tryBeginGatewaySuspendAdmission(() => {});
    if (suspension) {
      expect(suspension.commit()).toBe(true);
    }
    if (timing === "before admission") {
      controller.abort();
    }
    const run = vi.fn(async () => {});
    let outcome: "resolved" | "rejected" | undefined;
    let rejection: unknown;
    const completion = runWithGatewayIndependentRootWorkAdmission(
      run,
      "test:cancellable",
      controller.signal,
    ).then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = "rejected";
        rejection = error;
      },
    );
    try {
      if (timing === "during resume") {
        suspension?.release();
      }
      controller.abort();
      await nextTurn();
      expect.soft(outcome, "cancellation does not wait for suspension release").toBe("rejected");
    } finally {
      suspension?.release();
      await completion;
    }
    expect(rejection).toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  },
);

it("retains resumed independent work until its original completion after admission cancellation", async () => {
  const controller = new AbortController();
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const started = createDeferredCore();
  const release = createDeferredCore();
  let settled = false;
  const execution = runWithGatewayIndependentRootWorkAdmission(
    async () => {
      started.resolve();
      await release.promise;
    },
    "test:cancellable",
    controller.signal,
  ).then(() => {
    settled = true;
  });
  try {
    suspension?.release();
    await started.promise;
    controller.abort();
    await nextTurn();
    expect(settled).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
  } finally {
    suspension?.release();
    release.resolve();
    await execution;
  }
  expect(settled).toBe(true);
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("retires surviving root records across an in-process reset", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  await root?.run(async () => {
    resetGatewayWorkAdmission();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
    const nested = tryBeginGatewayRootWorkAdmission();
    expect(nested).not.toBeNull();
    expect(nested?.ownsRoot).toBe(true);
    await nested?.run(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
    });
    nested?.release();
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
  });
  root?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});
