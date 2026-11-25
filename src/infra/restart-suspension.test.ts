import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";
import { inspectors } from "./gateway-suspend-coordinator.test-support.js";
import {
  isGatewayRestartExternallyAllowed,
  setGatewayRestartPolicy,
  consumeGatewayRestartAuthorization,
  consumeGatewayRestartIntent,
  deferGatewayRestartUntilIdle,
  markGatewayRestartHandled,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
  setPreRestartDeferralCheck,
} from "./restart.js";

type DeferralOptions = Parameters<typeof deferGatewayRestartUntilIdle>[0];
type RestartDeferralHooks = NonNullable<DeferralOptions["hooks"]>;

const restartSignalHandler = vi.fn();
const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
const stuckPreparation = new Promise<void>(() => {});
async function advanceRestart(ms: number, signals: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(restartSignalHandler).toHaveBeenCalledTimes(signals);
}

function forceAfterBudget(
  emitHooks: NonNullable<DeferralOptions["emitHooks"]>,
  getPendingCount = () => 0,
) {
  const hooks = { onTimeout: vi.fn() };
  deferGatewayRestartUntilIdle({
    getPendingCount,
    maxWaitMs: 5_000,
    hooks,
    timeoutIntent: { force: true },
    emitHooks,
  });
  return hooks;
}

function blockedPreparation(fail = false) {
  const entered = createDeferred();
  const release = createDeferred();
  const beforeEmit = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    if (fail) {
      throw new Error("sentinel preparation failed");
    }
  });
  return { entered, release, beforeEmit };
}

function scheduleRequest(
  sessionKey: string,
  emitHooks: NonNullable<Parameters<typeof scheduleGatewayRestart>[0]>["emitHooks"],
  delayMs = 0,
) {
  return scheduleGatewayRestart({ delayMs, sessionKey, emitHooks });
}

function currentAuthority(isCurrent: () => boolean) {
  return () => {
    if (!isCurrent()) {
      throw new Error("requester revoked");
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  restartSignalHandler.mockClear();
  emitRestart.mockClear();
  resetGatewayLifecycleState();
  // A listener makes restart emission use process.emit instead of process.kill.
  process.on("SIGUSR2", restartSignalHandler);
});

afterEach(() => {
  resetGatewayLifecycleState();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.removeListener("SIGUSR2", restartSignalHandler);
});

describe("deferGatewayRestartUntilIdle timeout", () => {
  it("waits indefinitely when maxWaitMs is not specified", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
      onStillPending: vi.fn(),
    };

    deferGatewayRestartUntilIdle({ getPendingCount: () => 1, hooks });
    vi.advanceTimersByTime(600_000);
    expect(hooks.onTimeout).not.toHaveBeenCalled();
    expect(hooks.onStillPending).toHaveBeenCalled();
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  it("cancels a pending restart before it emits", async () => {
    let pending = 1;
    const preparation = createDeferred();
    const handle = deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      emitHooks: { beforeEmit: async () => await preparation.promise, emitRestart },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    handle.cancel();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    pending = 0;
    preparation.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitRestart).not.toHaveBeenCalled();
  });

  it("forces a timed-out restart while an admitted root remains", async () => {
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 10,
      timeoutIntent: { force: true },
      emitHooks: { emitRestart },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(emitRestart).toHaveBeenCalledOnce();
    root?.release();
  });

  it("reopens admission when a prepared restart is superseded", async () => {
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      emitHooks: { emitRestart: () => ({ status: "coalesced" }) },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each([
    { stage: "later", counts: [1, "throw", 0], errors: 1 },
    { stage: "final admission", counts: ["throw", 0, "throw"], errors: 2 },
  ])(
    "defers after a failed $stage inspection until a successful idle check",
    async ({ counts, errors }) => {
      const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onReady: vi.fn() };
      let call = 0;
      deferGatewayRestartUntilIdle({
        getPendingCount: () => {
          const next = counts[call++] ?? 0;
          if (next === "throw") {
            throw new Error("store corrupted");
          }
          if (typeof next !== "number") {
            throw new Error("Invalid test count");
          }
          return next;
        },
        hooks,
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(hooks.onCheckError).toHaveBeenCalledTimes(errors);
      expect(restartSignalHandler).not.toHaveBeenCalled();
      expect(hooks.onReady).not.toHaveBeenCalled();
      await advanceRestart(500, 1);
      expect(hooks.onReady).toHaveBeenCalledOnce();
    },
  );

  it("retries failed idle emissions through the configured budget", async () => {
    const hooks: RestartDeferralHooks = {
      onCheckError: vi.fn(),
      onReady: vi.fn(),
      onTimeout: vi.fn(),
    };
    let emitAttempts = 0;
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      maxWaitMs: 5_000,
      hooks,
      timeoutIntent: { force: true, reason: "gateway.restart.deferral-timeout" },
      emitHooks: {
        emitRestart: () => {
          emitAttempts += 1;
          throw new Error("independent-root admission rejected");
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const afterFirst = emitAttempts;
    expect(afterFirst).toBeGreaterThan(0);
    expect(hooks.onCheckError).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(emitAttempts).toBeGreaterThan(afterFirst);
    expect(hooks.onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(emitAttempts).toBeGreaterThan(1);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
  });

  it("supersedes stuck initial and forced preparations with fresh preparation", async () => {
    const beforeEmit = vi
      .fn(() => Promise.resolve())
      .mockReturnValueOnce(stuckPreparation)
      .mockReturnValueOnce(stuckPreparation);
    const hooks = forceAfterBudget({ beforeEmit, emitRestart });
    await vi.advanceTimersByTimeAsync(12_500);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(beforeEmit.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(emitRestart).toHaveBeenCalledOnce();
  });

  it("does not supersede a slow forced preparation that spans several poll intervals", async () => {
    const forced = createDeferred();
    const beforeEmit = vi.fn(() => forced.promise).mockReturnValueOnce(stuckPreparation);

    forceAfterBudget({ beforeEmit, emitRestart });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(beforeEmit).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(beforeEmit).toHaveBeenCalledTimes(2);

    forced.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(emitRestart).toHaveBeenCalledOnce();
  });

  it("keeps retrying the forced restart when its emission rejects after the deadline", async () => {
    let emitAttempts = 0;
    const retryEmission = vi.fn(() => {
      emitAttempts += 1;
      if (emitAttempts < 3) {
        throw new Error("independent-root admission rejected");
      }
      return { status: "emitted" as const };
    });

    const hooks = forceAfterBudget({ emitRestart: retryEmission }, () => 1);

    await vi.advanceTimersByTimeAsync(7_500);

    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(emitAttempts).toBeGreaterThanOrEqual(3);
  });

  it.each([false, true])(
    "keeps resumed admission under current deferral ownership (timeout=%s)",
    async (timeout) => {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      const preparation = createDeferred();
      const beforeEmit = vi.fn(async () => await preparation.promise);
      const handle = deferGatewayRestartUntilIdle({
        getPendingCount: () => 0,
        maxWaitMs: 5_000,
        emitHooks: { beforeEmit, emitRestart },
      });
      try {
        await vi.advanceTimersByTimeAsync(timeout ? 7_500 : 0);
        if (!timeout) {
          handle.cancel();
        }
        expect(suspension?.release()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(beforeEmit).toHaveBeenCalledTimes(timeout ? 1 : 0);
        handle.cancel();
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
        preparation.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(emitRestart).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        handle.cancel();
        suspension?.release();
        preparation.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );
  it("defers a scheduled restart after probe failure until its configured budget expires", async () => {
    setPreRestartDeferralCheck(() => {
      throw new Error("pending-work store unavailable");
    });
    scheduleGatewayRestart({ delayMs: 0 });
    await advanceRestart(0, 0);
    await advanceRestart(300_000, 1);
    expect(consumeGatewayRestartIntent()).toEqual({ force: true, waitMs: 300_000 });
  });
});

describe("scheduled restart requester authority", () => {
  it.each(["timer", "idle", "preparation", "failed-preparation"] as const)(
    "cancels a revoked request at the %s boundary and admits a later system restart",
    async (stage) => {
      let current = true;
      let pending = stage === "idle" ? 1 : 0;
      const { entered, release, beforeEmit } = blockedPreparation(stage === "failed-preparation");
      const afterEmitRejected = vi.fn(async () => {});
      setPreRestartDeferralCheck(() => pending);
      scheduleRequest(
        "requester-a",
        {
          assertCurrent: currentAuthority(() => current),
          beforeEmit,
          afterEmitRejected,
        },
        stage === "timer" ? 1_000 : 0,
      );
      if (stage !== "timer") {
        await vi.advanceTimersByTimeAsync(0);
      }
      if (stage.includes("preparation")) {
        await entered.promise;
      }
      current = false;
      pending = 0;
      release.resolve();
      await advanceRestart(1_000, 0);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(beforeEmit).toHaveBeenCalledTimes(stage.includes("preparation") ? 1 : 0);
      expect(afterEmitRejected).toHaveBeenCalledTimes(stage === "preparation" ? 1 : 0);
      scheduleGatewayRestart({ delayMs: 0 });
      await advanceRestart(0, 1);
    },
  );

  it.each(["second", "both", "system"] as const)(
    "keeps coalesced requester authority independent when %s is revoked",
    async (revoked) => {
      let firstCurrent = true;
      let secondCurrent = true;
      const firstPreparation = vi.fn(async () => {});
      const secondPreparation = vi.fn(async () => {});
      scheduleRequest(
        "requester-a",
        {
          assertCurrent: currentAuthority(() => firstCurrent),
          beforeEmit: firstPreparation,
        },
        1_000,
      );
      const second = scheduleRequest(
        "requester-b",
        revoked === "system"
          ? undefined
          : {
              assertCurrent: currentAuthority(() => secondCurrent),
              beforeEmit: secondPreparation,
            },
        1_000,
      );
      expect(second).toMatchObject({ coalesced: true, emitHooksQueued: false });
      firstCurrent = revoked === "second";
      secondCurrent = false;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(restartSignalHandler).toHaveBeenCalledTimes(revoked === "both" ? 0 : 1);
      expect(firstPreparation).toHaveBeenCalledTimes(firstCurrent ? 1 : 0);
      expect(secondPreparation).not.toHaveBeenCalled();
    },
  );

  it("accepts a live coalesced request while the original acknowledgement is preparing", async () => {
    let current = true;
    const { entered, release, beforeEmit } = blockedPreparation();
    const afterEmitRejected = vi.fn(async () => {});
    scheduleRequest("requester-a", {
      assertCurrent: currentAuthority(() => current),
      beforeEmit,
      afterEmitRejected,
    });
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    scheduleRequest("requester-b", { assertCurrent: () => {} });
    current = false;
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(afterEmitRejected).toHaveBeenCalledOnce();
    expect(restartSignalHandler).toHaveBeenCalledOnce();
  });
});

it("coalesces consumed authorization and intent until the signal is handled", () => {
  const intent = { force: true, reason: "first" };
  expect(requestGatewayRestartWithSignalAdmission("first", intent)).toEqual({ status: "emitted" });
  expect(consumeGatewayRestartAuthorization()).toBe(true);
  expect(consumeGatewayRestartIntent()).toEqual(intent);
  expect(requestGatewayRestartWithSignalAdmission("second")).toEqual({ status: "coalesced" });
  expect(restartSignalHandler).toHaveBeenCalledOnce();

  markGatewayRestartHandled();
  expect(requestGatewayRestartWithSignalAdmission("second")).toEqual({ status: "emitted" });
  expect(restartSignalHandler).toHaveBeenCalledTimes(2);
});

describe("restart control-flow deadlines use the monotonic clock", () => {
  it("expires SIGUSR2 authorization grace on monotonic time despite wall-clock rollback", () => {
    expect(requestGatewayRestartWithSignalAdmission("probe")).toEqual({ status: "emitted" });
    vi.advanceTimersByTime(4_000);
    vi.setSystemTime(Date.now() - 10_000);
    vi.advanceTimersByTime(4_000);
    expect(consumeGatewayRestartAuthorization()).toBe(false);
  });

  it("does not fire the deferral timeout early on a wall-clock forward jump", () => {
    const onTimeout = vi.fn();
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      hooks: { onTimeout },
      maxWaitMs: 120_000,
    });
    vi.advanceTimersByTime(10_000);
    vi.setSystemTime(Date.now() + 300_000);
    vi.advanceTimersByTime(500);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(110_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("keeps the restart cooldown across a wall-clock forward jump", () => {
    expect(requestGatewayRestartWithSignalAdmission("first")).toEqual({ status: "emitted" });
    expect(consumeGatewayRestartAuthorization()).toBe(true);
    markGatewayRestartHandled();

    vi.setSystemTime(Date.now() + 60_000);
    expect(scheduleGatewayRestart({ delayMs: 0, reason: "second" })).toMatchObject({
      cooldownMsApplied: 30_000,
      delayMs: 30_000,
    });
  });
});

const resumeScheduling = vi.fn();

function prepareSuspension(requestId = "request") {
  return prepareGatewaySuspend({
    requestId,
    createSuspensionId: () => "suspension",
    pauseScheduling: vi.fn(),
    resumeScheduling,
    inspect: inspectors({ getRootRequests: () => getActiveGatewayRootWorkCount() }),
  });
}

let emitSpy: MockInstance<typeof process.emit>;
function expectSignals(count: number) {
  expect(restartSignalHandler).toHaveBeenCalledTimes(count);
}

async function requestTargetedRestart() {
  const admission = tryBeginGatewayPreparedRestartRootWorkAdmission();
  expect(admission?.ownsRoot).toBe(true);
  const result = await admission?.run(async () =>
    requestGatewayRestartWithSignalAdmission("gateway.restart", { waitMs: 5_000 }),
  );
  admission?.release();
  return result;
}

function resetGatewayLifecycleState(): void {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  resetGatewayRestartStateForInProcessRestart();
  setGatewayRestartPolicy({ allowExternal: false });
  setPreRestartDeferralCheck(() => 0);
}

function schedulePreparingRestart(afterEmitRejected?: () => Promise<void>, reason?: string) {
  const { release, beforeEmit } = blockedPreparation();
  scheduleGatewayRestart({ delayMs: 0, reason, emitHooks: { beforeEmit, afterEmitRejected } });
  return { release: release.resolve, beforeEmit };
}

describe("scheduled restart during gateway suspension", () => {
  beforeEach(() => {
    resumeScheduling.mockReset();
    emitSpy = vi.spyOn(process, "emit");
  });

  it("defers a previously scheduled restart until a ready suspension resumes", async () => {
    scheduleGatewayRestart({ delayMs: 1_000, reason: "config.patch" });

    expect(prepareSuspension().status).toBe("ready");

    await advanceRestart(1_000, 0);

    expect(resumeGatewaySuspend("suspension")).toMatchObject({ ok: true, resumed: true });
    await advanceRestart(0, 1);
  });

  it.each(["emitted", "failed"])(
    "preserves suspension ownership when targeted restart is %s",
    async (status) => {
      expect(prepareSuspension()).toMatchObject({ status: "ready" });
      const restartHandler = () => markGatewayRestartDraining();
      if (status === "emitted") {
        process.on("SIGUSR2", restartHandler);
      } else {
        emitSpy.mockImplementationOnce(() => {
          throw new Error("synthetic signal failure");
        });
      }
      try {
        expect(await requestTargetedRestart()).toEqual({ status });
        expect(resumeScheduling).not.toHaveBeenCalled();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        if (status === "emitted") {
          expect(getGatewaySuspendStatus("suspension", true)).toMatchObject({
            status: "draining",
            ownerId: "request",
            phase: "interrupting",
          });
        } else {
          expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
          expect(getGatewaySuspendStatus("suspension").status).toBe("ready");
          expect(resumeGatewaySuspend("suspension")).toMatchObject({ ok: true, resumed: true });
          expect(resumeScheduling).toHaveBeenCalledOnce();
          expect(isGatewayWorkAdmissionClosed()).toBe(false);
        }
      } finally {
        process.removeListener("SIGUSR2", restartHandler);
      }
    },
  );

  it("reports active work while a due restart is preparing to emit", async () => {
    const preparation = schedulePreparingRestart(undefined, "config.patch");
    await vi.advanceTimersByTimeAsync(0);

    expect(prepareSuspension()).toMatchObject({
      status: "busy",
      reason: "gateway-draining",
      activeCount: 1,
    });
    expectSignals(0);

    preparation.release();
    await advanceRestart(0, 1);

    expect(prepareSuspension("next-request")).toMatchObject({
      status: "busy",
      reason: "gateway-draining",
    });
  });

  it("resets transient restart state and cooldown without dropping live bindings", async () => {
    const preRestartCheck = vi.fn(() => 0);
    setPreRestartDeferralCheck(preRestartCheck);
    setGatewayRestartPolicy({ allowExternal: true });

    scheduleGatewayRestart({ delayMs: 0 });
    await advanceRestart(0, 1);
    expect(preRestartCheck).toHaveBeenCalled();
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    resetGatewayRestartStateForInProcessRestart();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(isGatewayRestartExternallyAllowed()).toBe(true);
    preRestartCheck.mockClear();
    scheduleGatewayRestart({ delayMs: 0 });
    await advanceRestart(0, 2);
    expect(preRestartCheck).toHaveBeenCalled();
  });

  it.each([false, true])("cancels pending restart on reset (suspended: %s)", async (suspended) => {
    if (suspended) {
      expect(prepareSuspension()).toMatchObject({ status: "ready" });
    }
    scheduleGatewayRestart({ delayMs: suspended ? 0 : 1_000 });
    if (suspended) {
      await advanceRestart(0, 0);
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(getGatewaySuspendStatus("suspension")).toEqual({ status: "running" });
      resetGatewayWorkAdmission();
    }
    resetGatewayRestartStateForInProcessRestart();
    await advanceRestart(suspended ? 0 : 1_000, 0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("rejects prepared hooks that finish after a transient reset", async () => {
    const afterEmitRejected = vi.fn(async () => {});
    const preparation = schedulePreparingRestart(afterEmitRejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(preparation.beforeEmit).toHaveBeenCalledOnce();

    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    preparation.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(afterEmitRejected).toHaveBeenCalledOnce();
    expectSignals(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });
});
