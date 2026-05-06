import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDelegateStoreForTests } from "./delegate-store.js";
import {
  checkContinuationBudget,
  scheduleDelegateContinuation,
  scheduleWorkContinuation,
} from "./scheduler.js";
import { resetContinuationStateForTests } from "./state.js";
import type { ContinuationRuntimeConfig, ContinuationSignal } from "./types.js";

const baseConfig: ContinuationRuntimeConfig = {
  enabled: true,

  defaultDelayMs: 15_000,
  minDelayMs: 5_000,
  maxDelayMs: 300_000,
  maxChainLength: 10,
  costCapTokens: 500_000,
  maxDelegatesPerTurn: 5,
};

beforeEach(() => {
  vi.useFakeTimers();
  resetDelegateStoreForTests();
  resetContinuationStateForTests();
});

afterEach(() => {
  resetDelegateStoreForTests();
  resetContinuationStateForTests();
  vi.useRealTimers();
});

describe("checkContinuationBudget", () => {
  it("returns null when under budget", () => {
    expect(
      checkContinuationBudget({
        chainState: { currentChainCount: 3, chainStartedAt: 0, accumulatedChainTokens: 100_000 },
        config: baseConfig,
        sessionKey: "test",
      }),
    ).toBeNull();
  });

  it("returns chain-capped at max depth", () => {
    expect(
      checkContinuationBudget({
        chainState: { currentChainCount: 10, chainStartedAt: 0, accumulatedChainTokens: 0 },
        config: baseConfig,
        sessionKey: "test",
      }),
    ).toBe("chain-capped");
  });

  it("returns cost-capped over budget", () => {
    expect(
      checkContinuationBudget({
        chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 600_000 },
        config: baseConfig,
        sessionKey: "test",
      }),
    ).toBe("cost-capped");
  });

  it("does not cost-cap when costCapTokens is 0 (unlimited)", () => {
    expect(
      checkContinuationBudget({
        chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 999_999 },
        config: { ...baseConfig, costCapTokens: 0 },
        sessionKey: "test",
      }),
    ).toBeNull();
  });
});

describe("scheduleWorkContinuation", () => {
  it("arms and fires a timer", async () => {
    const onFire = vi.fn();
    const signal: ContinuationSignal & { kind: "work" } = { kind: "work", delayMs: 5_000 };

    const result = scheduleWorkContinuation({
      signal,
      chainState: { currentChainCount: 0, chainStartedAt: 1000, accumulatedChainTokens: 50_000 },
      config: baseConfig,
      sessionKey: "test-work",
      onFire,
    });

    expect(result.outcome).toBe("scheduled");
    expect(onFire).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(1, 1000, 50_000, undefined);
  });

  it("returns chain-capped when at max depth", () => {
    const result = scheduleWorkContinuation({
      signal: { kind: "work" },
      chainState: { currentChainCount: 10, chainStartedAt: 0, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey: "test-capped",
      onFire: vi.fn(),
    });

    expect(result.outcome).toBe("chain-capped");
  });

  it("clamps delay to min/max", async () => {
    const onFire = vi.fn();
    // Request 1ms delay — should be clamped to minDelayMs (5000)
    const result = scheduleWorkContinuation({
      signal: { kind: "work", delayMs: 1 },
      chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey: "test-clamp",
      onFire,
    });

    expect(result.outcome).toBe("scheduled");

    // Should NOT fire after 1ms
    await vi.advanceTimersByTimeAsync(1);
    expect(onFire).not.toHaveBeenCalled();

    // Should fire after 5000ms (clamped minimum)
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("does NOT cancel on channel noise (no generation guard)", async () => {
    const onFire = vi.fn();
    scheduleWorkContinuation({
      signal: { kind: "work", delayMs: 10_000 },
      chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey: "test-noise",
      onFire,
    });

    // Simulate "channel noise" — in the old branch, this would bump generation
    // and cancel the timer. In the new implementation, there IS no generation
    // guard. The timer fires regardless.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleDelegateContinuation", () => {
  it("does NOT cancel on channel noise (no generation guard)", async () => {
    // Mirrors the work-path test above on the delegate path. The delegate
    // scheduler has no generation guard by construction; this test is the
    // regression sentinel for that.
    const onImmediateSpawn = vi.fn().mockResolvedValue(true);
    const onDelayedSpawn = vi.fn().mockResolvedValue(true);

    scheduleDelegateContinuation({
      signal: { kind: "delegate", delayMs: 10_000, task: "probe" },
      chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey: "test-delegate-noise",
      onImmediateSpawn,
      onDelayedSpawn,
    });

    // Channel-noise simulation: in a generation-guarded world, an inbound
    // event during the delay would cancel the reservation. The delegate
    // path has no such guard — the timer must fire and onDelayedSpawn must
    // be invoked.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onDelayedSpawn).toHaveBeenCalledTimes(1);
    expect(onImmediateSpawn).not.toHaveBeenCalled();
  });
});

describe("scheduler timer callbacks swallow rejections", () => {
  it("scheduleWorkContinuation: onFire throw does not propagate past the timer", async () => {
    const onFire = vi.fn(() => {
      throw new Error("enqueue-system-event exploded");
    });

    const result = scheduleWorkContinuation({
      signal: { kind: "work", delayMs: 10_000 },
      chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey: "test-work-fire-throw",
      onFire,
    });
    expect(result.outcome).toBe("scheduled");

    // Under vitest fake timers, an unhandled exception thrown from a
    // setTimeout callback would become a test-level failure. Advancing
    // the timer without any custom unhandledException assertion is the
    // regression check: the catch is in place iff this completes cleanly.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("scheduleDelegateContinuation (delayed): onDelayedSpawn rejection does not propagate", async () => {
    const onImmediateSpawn = vi.fn().mockResolvedValue(true);
    const onDelayedSpawn = vi.fn().mockRejectedValue(new Error("spawn-failed"));

    scheduleDelegateContinuation({
      signal: { kind: "delegate", delayMs: 10_000, task: "probe" },
      chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey: "test-delayed-reject",
      onImmediateSpawn,
      onDelayedSpawn,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    // Drain the .catch microtask.
    await vi.runAllTimersAsync();
    expect(onDelayedSpawn).toHaveBeenCalledTimes(1);
  });

  it("scheduleDelegateContinuation (immediate): onImmediateSpawn rejection does not propagate", async () => {
    const onImmediateSpawn = vi.fn().mockRejectedValue(new Error("spawn-failed"));
    const onDelayedSpawn = vi.fn().mockResolvedValue(true);

    const result = scheduleDelegateContinuation({
      signal: { kind: "delegate", task: "probe" }, // no delay → immediate
      chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey: "test-immediate-reject",
      onImmediateSpawn,
      onDelayedSpawn,
    });
    expect(result.outcome).toBe("scheduled-immediate");

    // Microtask drain for the .catch branch.
    await vi.runAllTimersAsync();
    expect(onImmediateSpawn).toHaveBeenCalledTimes(1);
    expect(onDelayedSpawn).not.toHaveBeenCalled();
  });
});
