// Tests restart deferral timeout behavior and fallback cleanup.
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
  consumeGatewayRestartIntent,
  deferGatewayRestartUntilIdle,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
  setPreRestartDeferralCheck,
} from "./restart.js";

type RestartDeferralHooks = NonNullable<
  Parameters<typeof deferGatewayRestartUntilIdle>[0]["hooks"]
>;

const restartSignalHandler = () => {};

describe("deferGatewayRestartUntilIdle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
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

  it("respects custom maxWaitMs configuration", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 120_000,
      hooks,
    });

    vi.advanceTimersByTime(119_999);
    expect(hooks.onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
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

  it("carries timeout restart intent when the deferral budget is exhausted", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 1_000,
      hooks,
      timeoutIntent: { force: true, reason: "gateway.restart.deferral-timeout" },
    });

    vi.advanceTimersByTime(1_000);

    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(consumeGatewayRestartIntent()).toEqual({
      force: true,
      drainBudgetExhausted: true,
      reason: "gateway.restart.deferral-timeout",
    });
  });

  it("calls onReady and does not timeout when pending count drops to 0", async () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };
    let pending = 3;

    deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      hooks,
    });

    vi.advanceTimersByTime(1_000);
    expect(hooks.onReady).not.toHaveBeenCalled();

    pending = 0;
    await vi.advanceTimersByTimeAsync(500);
    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(hooks.onTimeout).not.toHaveBeenCalled();
  });

  it("cancels a pending deferral before it can emit", () => {
    let pending = 1;
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handle = deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      emitHooks: { emitRestart },
    });

    handle.cancel();
    pending = 0;
    vi.advanceTimersByTime(1_000);

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

  it("reopens admission when a blocked preparation is cancelled", async () => {
    const { promise: preparation, resolve: releasePreparation } = createDeferred();
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handle = deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      emitHooks: {
        beforeEmit: async () => await preparation,
        emitRestart,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    handle.cancel();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    releasePreparation?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(emitRestart).not.toHaveBeenCalled();
  });

  it("reopens admission when a prepared restart is superseded", async () => {
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      emitHooks: { emitRestart: () => ({ status: "coalesced" }) },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("immediately restarts when pending count is 0", async () => {
    const hooks: RestartDeferralHooks = {
      onReady: vi.fn(),
      onTimeout: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      hooks,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(hooks.onTimeout).not.toHaveBeenCalled();
  });

  it("defers instead of restarting when the initial pending inspection throws", async () => {
    let emissions = 0;
    const countEmission = () => {
      emissions += 1;
    };
    process.on("SIGUSR2", countEmission);
    try {
      const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onReady: vi.fn() };
      let call = 0;

      deferGatewayRestartUntilIdle({
        getPendingCount: () => {
          call += 1;
          if (call === 1) {
            throw new Error("store corrupted");
          }
          return 0;
        },
        pollMs: 10,
        hooks,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(hooks.onCheckError).toHaveBeenCalledOnce();
      expect(emissions).toBe(0);
      expect(hooks.onReady).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      expect(emissions).toBe(1);
      expect(hooks.onReady).toHaveBeenCalledOnce();
    } finally {
      process.removeListener("SIGUSR2", countEmission);
    }
  });

  it("keeps the deferral polling when a later pending inspection throws", async () => {
    let emissions = 0;
    const countEmission = () => {
      emissions += 1;
    };
    process.on("SIGUSR2", countEmission);
    try {
      const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onReady: vi.fn() };
      const counts: Array<number | "throw"> = [1, "throw", 0];
      let call = 0;

      deferGatewayRestartUntilIdle({
        getPendingCount: () => {
          const next = counts[Math.min(call, counts.length - 1)];
          call += 1;
          if (next === "throw") {
            throw new Error("store corrupted");
          }
          return next as number;
        },
        pollMs: 10,
        hooks,
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(hooks.onCheckError).toHaveBeenCalledOnce();
      expect(emissions).toBe(0);

      await vi.advanceTimersByTimeAsync(10);
      expect(emissions).toBe(1);
      expect(hooks.onReady).toHaveBeenCalledOnce();
    } finally {
      process.removeListener("SIGUSR2", countEmission);
    }
  });

  it("does not emit when the final admission-time pending read throws", async () => {
    let emissions = 0;
    const countEmission = () => {
      emissions += 1;
    };
    process.on("SIGUSR2", countEmission);
    try {
      const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onReady: vi.fn() };
      const counts: Array<number | "throw"> = ["throw", 0, "throw"];
      let call = 0;

      deferGatewayRestartUntilIdle({
        getPendingCount: () => {
          const next = call < counts.length ? counts[call] : 0;
          call += 1;
          if (next === "throw") {
            throw new Error("store corrupted");
          }
          return next as number;
        },
        pollMs: 10,
        hooks,
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(emissions).toBe(0);

      await vi.advanceTimersByTimeAsync(10);
      expect(emissions).toBe(1);
    } finally {
      process.removeListener("SIGUSR2", countEmission);
    }
  });

  it("keeps deferring when the emission itself rejects", async () => {
    const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onReady: vi.fn() };
    let emitAttempts = 0;

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      pollMs: 10,
      hooks,
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
  });

  it("still escalates through the deferral budget when inspection never recovers", async () => {
    const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onTimeout: vi.fn() };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => {
        throw new Error("store corrupted");
      },
      pollMs: 10,
      maxWaitMs: 100,
      hooks,
      timeoutIntent: { force: true, reason: "gateway.restart.deferral-timeout" },
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(consumeGatewayRestartIntent()).toEqual({
      force: true,
      drainBudgetExhausted: true,
      reason: "gateway.restart.deferral-timeout",
    });
  });

  it("supersedes a stuck preparation at the deadline with a fresh one, not a bypassed one", async () => {
    const hooks: RestartDeferralHooks = { onTimeout: vi.fn() };
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    let beforeEmitCalls = 0;
    const beforeEmit = vi.fn(() => {
      beforeEmitCalls += 1;
      return beforeEmitCalls === 1 ? new Promise<void>(() => {}) : Promise.resolve();
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

    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(beforeEmitCalls).toBeGreaterThan(1);
    expect(emitRestart).toHaveBeenCalledOnce();
  });

  it("supersedes a forced preparation that also hangs after the deadline", async () => {
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

  it("still escalates through maxWaitMs when idle emission keeps failing", async () => {
    const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onTimeout: vi.fn() };
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

    await vi.advanceTimersByTimeAsync(100);

    expect(emitAttempts).toBeGreaterThan(1);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
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
    expect(consumeGatewayRestartIntent()).toEqual({ force: true, drainBudgetExhausted: true });
  });
});
