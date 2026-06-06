import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerRecords: Array<{ level: string; message: string }> = [];

vi.mock("../../logging/subsystem.js", () => {
  const record =
    (level: string) =>
    (message: string): void => {
      loggerRecords.push({ level, message });
    };
  const logger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    raw: record("raw"),
    child: () => logger,
  };
  return {
    createSubsystemLogger: () => logger,
  };
});

import { resetDelegateStoreForTests } from "./delegate-store.js";
import { scheduleWorkContinuation } from "./scheduler.js";
import { hasLiveContinuationTimerRefs, resetContinuationStateForTests } from "./state.js";
import type { ContinuationRuntimeConfig, ContinuationSignal } from "./types.js";

const baseConfig: ContinuationRuntimeConfig = {
  enabled: true,
  defaultDelayMs: 15_000,
  minDelayMs: 5_000,
  maxDelayMs: 300_000,
  maxChainLength: 10,
  costCapTokens: 500_000,
  maxDelegatesPerTurn: 5,
  crossSessionTargeting: "disabled",
};

const workSignal: ContinuationSignal & { kind: "work" } = { kind: "work", delayMs: 5_000 };

beforeEach(() => {
  vi.useFakeTimers();
  resetDelegateStoreForTests();
  resetContinuationStateForTests();
  loggerRecords.length = 0;
});

afterEach(() => {
  resetDelegateStoreForTests();
  resetContinuationStateForTests();
  vi.useRealTimers();
});

describe("scheduleWorkContinuation onFire-throws spiderweb", () => {
  it("releases timer ref after onFire throws", async () => {
    const sessionKey = "test-throw-cleanup";
    const onFire = vi.fn(() => {
      throw new Error("bounded-queue full");
    });

    scheduleWorkContinuation({
      signal: workSignal,
      chainState: { currentChainCount: 0, chainStartedAt: 1000, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey,
      onFire,
    });

    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
  });

  it("emits warn-class log when onFire throws an Error", async () => {
    const sessionKey = "test-throw-warn-error";

    scheduleWorkContinuation({
      signal: workSignal,
      chainState: { currentChainCount: 0, chainStartedAt: 1000, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey,
      onFire: () => {
        throw new Error("disk write failed");
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const warns = loggerRecords.filter((r) => r.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0].message).toContain("[continuation:work-fire-failed]");
    expect(warns[0].message).toContain(`session=${sessionKey}`);
    expect(warns[0].message).toContain("disk write failed");
  });

  it("emits warn-class log when onFire throws a non-Error value", async () => {
    const sessionKey = "test-throw-warn-string";

    scheduleWorkContinuation({
      signal: workSignal,
      chainState: { currentChainCount: 0, chainStartedAt: 1000, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey,
      onFire: () => {
        throw new Error("raw string rejection");
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const warns = loggerRecords.filter((r) => r.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0].message).toContain("raw string rejection");
  });

  it("passes workReason to onFire before throw", async () => {
    const sessionKey = "test-throw-workreason";
    const receivedArgs: unknown[] = [];

    scheduleWorkContinuation({
      signal: workSignal,
      chainState: { currentChainCount: 2, chainStartedAt: 5000, accumulatedChainTokens: 80_000 },
      config: baseConfig,
      sessionKey,
      onFire: (...args: unknown[]) => {
        receivedArgs.push(...args);
        throw new Error("after-capture throw");
      },
      workReason: "context-pressure-auto",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(receivedArgs).toEqual([3, 5000, 80_000, "context-pressure-auto"]);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
  });

  it("sibling timer still fires when one onFire throws", async () => {
    const sessionKey = "test-throw-sibling";
    const sideEffects: string[] = [];

    scheduleWorkContinuation({
      signal: { kind: "work", delayMs: 5_000 },
      chainState: { currentChainCount: 0, chainStartedAt: 1000, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey,
      onFire: () => {
        sideEffects.push("first-fired");
        throw new Error("first timer explodes");
      },
    });

    scheduleWorkContinuation({
      signal: { kind: "work", delayMs: 5_000 },
      chainState: { currentChainCount: 1, chainStartedAt: 1000, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey,
      onFire: () => {
        sideEffects.push("second-fired");
      },
    });

    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sideEffects).toEqual(["first-fired", "second-fired"]);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
  });

  it("observes partial side-effect then cleans up after throw", async () => {
    const sessionKey = "test-throw-partial";
    let sideEffectApplied = false;

    scheduleWorkContinuation({
      signal: workSignal,
      chainState: { currentChainCount: 0, chainStartedAt: 1000, accumulatedChainTokens: 0 },
      config: baseConfig,
      sessionKey,
      onFire: () => {
        sideEffectApplied = true;
        throw new Error("explodes after partial work");
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sideEffectApplied).toBe(true);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
    const warns = loggerRecords.filter((r) => r.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0].message).toContain("explodes after partial work");
  });
});
