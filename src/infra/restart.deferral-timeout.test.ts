import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  consumeGatewayRestartAuthorization,
  consumeGatewayRestartIntent,
  deferGatewayRestartUntilIdle,
  markGatewayRestartHandled,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
  setPreRestartDeferralCheck,
} from "./restart.js";

type RestartDeferralHooks = NonNullable<
  Parameters<typeof deferGatewayRestartUntilIdle>[0]["hooks"]
>;

const restartSignalHandler = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  restartSignalHandler.mockClear();
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  setPreRestartDeferralCheck(() => 0);
  // A listener makes restart emission use process.emit instead of process.kill.
  process.on("SIGUSR2", restartSignalHandler);
});

afterEach(() => {
  setPreRestartDeferralCheck(() => 0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  process.removeListener("SIGUSR2", restartSignalHandler);
});

describe("deferGatewayRestartUntilIdle timeout", () => {
  it("waits indefinitely when maxWaitMs is not specified", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
      onStillPending: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      hooks,
    });

    vi.advanceTimersByTime(300_000);
    expect(hooks.onTimeout).not.toHaveBeenCalled();
    expect(hooks.onStillPending).toHaveBeenCalled();

    vi.advanceTimersByTime(300_000);
    expect(hooks.onTimeout).not.toHaveBeenCalled();
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  it("clamps oversized poll intervals instead of polling immediately", () => {
    const hooks: RestartDeferralHooks = { onReady: vi.fn() };
    let pending = 1;

    deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      pollMs: Number.MAX_SAFE_INTEGER,
      hooks,
    });

    pending = 0;
    vi.advanceTimersByTime(1);
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  it("cancels a pending restart before it emits", async () => {
    let pending = 1;
    const preparation = createDeferred();
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
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
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 10,
      pollMs: 10,
      timeoutIntent: { force: true },
      emitHooks: { emitRestart },
    });
    await vi.advanceTimersByTimeAsync(10);

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
    { stage: "later", counts: [1, "throw", 0], firstCheckMs: 10, errors: 1 },
    { stage: "final admission", counts: ["throw", 0, "throw"], firstCheckMs: 10, errors: 2 },
  ])(
    "defers after a failed $stage inspection until a successful idle check",
    async ({ counts, firstCheckMs, errors }) => {
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
        pollMs: 10,
        hooks,
      });
      await vi.advanceTimersByTimeAsync(firstCheckMs);
      expect(hooks.onCheckError).toHaveBeenCalledTimes(errors);
      expect(restartSignalHandler).not.toHaveBeenCalled();
      expect(hooks.onReady).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(restartSignalHandler).toHaveBeenCalledOnce();
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
      pollMs: 10,
      maxWaitMs: 100,
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
    await vi.advanceTimersByTimeAsync(50);
    expect(emitAttempts).toBeGreaterThan(afterFirst);
    expect(hooks.onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(emitAttempts).toBeGreaterThan(1);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
  });

  it("supersedes stuck initial and forced preparations with fresh preparation", async () => {
    const hooks: RestartDeferralHooks = { onTimeout: vi.fn() };
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    let beforeEmitCalls = 0;
    const beforeEmit = vi.fn(() => {
      beforeEmitCalls += 1;
      return beforeEmitCalls <= 2 ? new Promise<void>(() => {}) : Promise.resolve();
    });
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      maxWaitMs: 100,
      pollMs: 10,
      hooks,
      timeoutIntent: { force: true },
      emitHooks: { beforeEmit, emitRestart },
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(beforeEmitCalls).toBeGreaterThanOrEqual(3);
    expect(emitRestart).toHaveBeenCalledOnce();
  });

  it("does not supersede a slow forced preparation that spans several poll intervals", async () => {
    const hooks: RestartDeferralHooks = { onTimeout: vi.fn() };
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    let beforeEmitCalls = 0;
    let releaseForced: (() => void) | undefined;
    const beforeEmit = vi.fn(() => {
      beforeEmitCalls += 1;
      return beforeEmitCalls === 1
        ? new Promise<void>(() => {})
        : new Promise<void>((resolve) => {
            releaseForced = resolve;
          });
    });

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      maxWaitMs: 100,
      pollMs: 10,
      hooks,
      timeoutIntent: { force: true },
      emitHooks: { beforeEmit, emitRestart },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(beforeEmitCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(50);
    expect(beforeEmitCalls).toBe(2);

    releaseForced?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(emitRestart).toHaveBeenCalledOnce();
  });

  it("keeps retrying the forced restart when its emission rejects after the deadline", async () => {
    const hooks: RestartDeferralHooks = { onTimeout: vi.fn() };
    let emitAttempts = 0;
    const emitRestart = vi.fn(() => {
      emitAttempts += 1;
      if (emitAttempts < 3) {
        throw new Error("independent-root admission rejected");
      }
      return { status: "emitted" as const };
    });

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 100,
      pollMs: 10,
      hooks,
      timeoutIntent: { force: true },
      emitHooks: { emitRestart },
    });

    await vi.advanceTimersByTimeAsync(150);

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
      const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
      const handle = deferGatewayRestartUntilIdle({
        getPendingCount: () => 0,
        pollMs: 10,
        maxWaitMs: 100,
        emitHooks: { beforeEmit, emitRestart },
      });
      try {
        await vi.advanceTimersByTimeAsync(timeout ? 150 : 0);
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
    const emit = vi.spyOn(process, "emit");
    setPreRestartDeferralCheck(() => {
      throw new Error("pending-work store unavailable");
    });
    scheduleGatewayRestart({ delayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).not.toHaveBeenCalledWith("SIGUSR2");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(emit.mock.calls.filter(([event]) => event === "SIGUSR2")).toHaveLength(1);
    expect(consumeGatewayRestartIntent()).toEqual({ force: true, waitMs: 300_000 });
  });
});

describe("scheduled restart requester authority", () => {
  it.each(["timer", "idle", "preparation", "failed-preparation"] as const)(
    "cancels a revoked request at the %s boundary and admits a later system restart",
    async (stage) => {
      let current = true;
      let pending = stage === "idle" ? 1 : 0;
      const entered = createDeferred();
      const release = createDeferred();
      const beforeEmit = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        if (stage === "failed-preparation") {
          throw new Error("sentinel preparation failed");
        }
      });
      const afterEmitRejected = vi.fn(async () => {});
      setPreRestartDeferralCheck(() => pending);
      scheduleGatewayRestart({
        delayMs: stage === "timer" ? 1_000 : 0,
        sessionKey: "requester-a",
        emitHooks: {
          assertCurrent: () => {
            if (!current) {
              throw new Error("linked administrator was demoted");
            }
          },
          beforeEmit,
          afterEmitRejected,
        },
      });
      if (stage === "preparation" || stage === "failed-preparation") {
        await vi.advanceTimersByTimeAsync(0);
        await entered.promise;
      } else if (stage === "idle") {
        await vi.advanceTimersByTimeAsync(0);
      }
      current = false;
      pending = 0;
      release.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(restartSignalHandler).not.toHaveBeenCalled();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(beforeEmit).toHaveBeenCalledTimes(stage.includes("preparation") ? 1 : 0);
      expect(afterEmitRejected).toHaveBeenCalledTimes(stage === "preparation" ? 1 : 0);
      scheduleGatewayRestart({ delayMs: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(restartSignalHandler).toHaveBeenCalledOnce();
    },
  );

  it.each(["second", "both", "system"] as const)(
    "keeps coalesced requester authority independent when %s is revoked",
    async (revoked) => {
      let firstCurrent = true;
      let secondCurrent = true;
      const firstPreparation = vi.fn(async () => {});
      const secondPreparation = vi.fn(async () => {});
      scheduleGatewayRestart({
        delayMs: 1_000,
        sessionKey: "requester-a",
        emitHooks: {
          assertCurrent: () => {
            if (!firstCurrent) {
              throw new Error("first requester revoked");
            }
          },
          beforeEmit: firstPreparation,
        },
      });
      const second = scheduleGatewayRestart({
        delayMs: 1_000,
        sessionKey: "requester-b",
        ...(revoked === "system"
          ? {}
          : {
              emitHooks: {
                assertCurrent: () => {
                  if (!secondCurrent) {
                    throw new Error("second requester revoked");
                  }
                },
                beforeEmit: secondPreparation,
              },
            }),
      });
      expect(second.coalesced).toBe(true);
      expect(second.emitHooksQueued).toBe(false);
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
    const entered = createDeferred();
    const release = createDeferred();
    const afterEmitRejected = vi.fn(async () => {});
    scheduleGatewayRestart({
      delayMs: 0,
      sessionKey: "requester-a",
      emitHooks: {
        assertCurrent: () => {
          if (!current) {
            throw new Error("original requester revoked");
          }
        },
        beforeEmit: async () => {
          entered.resolve();
          await release.promise;
        },
        afterEmitRejected,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    scheduleGatewayRestart({
      delayMs: 0,
      sessionKey: "requester-b",
      emitHooks: { assertCurrent: () => {} },
    });
    current = false;
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(afterEmitRejected).toHaveBeenCalledOnce();
    expect(restartSignalHandler).toHaveBeenCalledOnce();
  });
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
    const second = scheduleGatewayRestart({ delayMs: 0, reason: "second" });
    expect(second.cooldownMsApplied).toBe(30_000);
    expect(second.delayMs).toBe(30_000);
  });
});
