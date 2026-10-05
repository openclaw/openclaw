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

const restartSignalHandler = vi.fn();

describe("deferGatewayRestartUntilIdle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    restartSignalHandler.mockClear();
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

  it.each([
    { inspection: "pending", maxWaitMs: 120_000 },
    { inspection: "unavailable", maxWaitMs: 100 },
  ])(
    "carries timeout intent at the configured budget when inspection is $inspection",
    async ({ inspection, maxWaitMs }) => {
      const hooks: RestartDeferralHooks = {
        onCheckError: vi.fn(),
        onTimeout: vi.fn(),
        onReady: vi.fn(),
      };
      deferGatewayRestartUntilIdle({
        getPendingCount: () => {
          if (inspection === "unavailable") {
            throw new Error("store corrupted");
          }
          return 1;
        },
        maxWaitMs,
        pollMs: 10,
        hooks,
        timeoutIntent: { force: true, reason: "gateway.restart.deferral-timeout" },
      });
      await vi.advanceTimersByTimeAsync(maxWaitMs - 1);
      expect(hooks.onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.onTimeout).toHaveBeenCalledOnce();
      expect(consumeGatewayRestartIntent()).toEqual({
        force: true,
        waitMs: 300_000,
        reason: "gateway.restart.deferral-timeout",
      });
    },
  );

  it.each([0, 3])("restarts once pending work drains from %s", async (initialPending) => {
    const hooks: RestartDeferralHooks = { onTimeout: vi.fn(), onReady: vi.fn() };
    let pending = initialPending;
    deferGatewayRestartUntilIdle({ getPendingCount: () => pending, hooks });
    if (initialPending > 0) {
      vi.advanceTimersByTime(1_000);
      expect(hooks.onReady).not.toHaveBeenCalled();
    }
    pending = 0;
    await vi.advanceTimersByTimeAsync(initialPending > 0 ? 500 : 0);
    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(hooks.onTimeout).not.toHaveBeenCalled();
  });

  it.each(["pending", "preparing"])("cancels a %s restart before it emits", async (stage) => {
    let pending = stage === "pending" ? 1 : 0;
    const preparation = createDeferred();
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handle = deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      emitHooks: { beforeEmit: async () => await preparation.promise, emitRestart },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(stage === "preparing");
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
    { stage: "initial", counts: ["throw", 0], firstCheckMs: 0, errors: 1 },
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

  it.each([undefined, 100])("retries failed idle emissions within budget %s", async (maxWaitMs) => {
    const hooks: RestartDeferralHooks = {
      onCheckError: vi.fn(),
      onReady: vi.fn(),
      onTimeout: vi.fn(),
    };
    let emitAttempts = 0;
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      pollMs: 10,
      maxWaitMs,
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
    if (maxWaitMs !== undefined) {
      await vi.advanceTimersByTimeAsync(50);
      expect(emitAttempts).toBeGreaterThan(1);
      expect(hooks.onTimeout).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { hungAttempts: 1, elapsed: 100 },
    { hungAttempts: 2, elapsed: 250 },
  ])(
    "supersedes $hungAttempts stuck preparations with fresh preparation",
    async ({ hungAttempts, elapsed }) => {
      const hooks: RestartDeferralHooks = { onTimeout: vi.fn() };
      const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
      let beforeEmitCalls = 0;
      const beforeEmit = vi.fn(() => {
        beforeEmitCalls += 1;
        return beforeEmitCalls <= hungAttempts ? new Promise<void>(() => {}) : Promise.resolve();
      });
      deferGatewayRestartUntilIdle({
        getPendingCount: () => 0,
        maxWaitMs: 100,
        pollMs: 10,
        hooks,
        timeoutIntent: { force: true },
        emitHooks: { beforeEmit, emitRestart },
      });
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(hooks.onTimeout).toHaveBeenCalledOnce();
      expect(beforeEmitCalls).toBeGreaterThanOrEqual(hungAttempts + 1);
      expect(emitRestart).toHaveBeenCalledOnce();
    },
  );

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
