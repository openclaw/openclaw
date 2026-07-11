// Tests restart deferral timeout behavior and fallback cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  consumeGatewaySigusr1RestartIntent,
  deferGatewayRestartUntilIdle,
  scheduleGatewaySigusr1Restart,
  setPreRestartDeferralCheck,
  type RestartDeferralHooks,
} from "./restart.js";

describe("deferGatewayRestartUntilIdle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testing.resetSigusr1State();
    // Add a listener so emitGatewayRestart uses process.emit instead of process.kill
    process.on("SIGUSR1", () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    testing.resetSigusr1State();
    process.removeAllListeners("SIGUSR1");
  });

  it("waits indefinitely when maxWaitMs is not specified", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
      onStillPending: vi.fn(),
    };

    // Always return 1 pending item to prevent draining
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

    const customTimeoutMs = 120_000; // 2 minutes

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: customTimeoutMs,
      hooks,
    });

    // Advance to just before 2 minutes
    vi.advanceTimersByTime(119_999);
    expect(hooks.onTimeout).not.toHaveBeenCalled();

    // Advance past 2 minutes
    vi.advanceTimersByTime(1);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
  });

  it("clamps oversized poll intervals instead of polling immediately", () => {
    const hooks: RestartDeferralHooks = {
      onReady: vi.fn(),
    };
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
    expect(consumeGatewaySigusr1RestartIntent()).toEqual({
      force: true,
      reason: "gateway.restart.deferral-timeout",
    });
  });

  it("calls onReady and does not timeout when pending count drops to 0", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };

    let pending = 3;

    deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      hooks,
    });

    // Advance a few poll intervals, then drain
    vi.advanceTimersByTime(1000);
    expect(hooks.onReady).not.toHaveBeenCalled();

    pending = 0;
    vi.advanceTimersByTime(500); // Next poll interval
    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(hooks.onTimeout).not.toHaveBeenCalled();
  });

  it("immediately restarts when pending count is 0", () => {
    const hooks: RestartDeferralHooks = {
      onReady: vi.fn(),
      onTimeout: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      hooks,
    });

    // onReady should be called synchronously
    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(hooks.onTimeout).not.toHaveBeenCalled();
  });

  it("handles getPendingCount error by restarting immediately", () => {
    const hooks: RestartDeferralHooks = {
      onCheckError: vi.fn(),
      onReady: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => {
        throw new Error("store corrupted");
      },
      hooks,
    });

    expect(hooks.onCheckError).toHaveBeenCalledOnce();
    expect(hooks.onReady).not.toHaveBeenCalled();
  });
});

describe("scheduleGatewaySigusr1Restart background-exec deferral", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testing.resetSigusr1State();
    // Ensure emit mode uses process.emit rather than process.kill.
    process.on("SIGUSR1", () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    testing.resetSigusr1State();
    process.removeAllListeners("SIGUSR1");
  });

  it("withholds SIGUSR1 while background exec sessions are running and emits after they exit", () => {
    const emitSpy = vi.spyOn(process, "emit").mockReturnValue(true);
    let backgroundExecCount = 1;
    setPreRestartDeferralCheck(() => backgroundExecCount);

    scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "test.background-exec" });

    // Let the initial timeout fire and begin deferral polling.
    vi.advanceTimersByTime(0);
    expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

    // Simulate the background exec session exiting.
    backgroundExecCount = 0;
    vi.advanceTimersByTime(1_000);

    expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
  });
});
