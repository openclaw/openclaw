import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";

describe("createTypingKeepaliveLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resets error count on successful tick", async () => {
    let calls = 0;
    const loop = createTypingKeepaliveLoop({
      intervalMs: 100,
      onTick: () => {
        calls += 1;
        if (calls <= 2) {
          throw new Error("network error");
        }
      },
      maxConsecutiveErrors: 3,
    });

    loop.start();
    // Tick 1: error (consecutiveErrors=1)
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.isRunning()).toBe(true);
    // Tick 2: error (consecutiveErrors=2)
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.isRunning()).toBe(true);
    // Tick 3: success (consecutiveErrors reset to 0)
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.isRunning()).toBe(true);
    expect(calls).toBe(3);
    loop.stop();
  });

  it("stops after maxConsecutiveErrors consecutive failures", async () => {
    const loop = createTypingKeepaliveLoop({
      intervalMs: 100,
      onTick: () => {
        throw new Error("network error");
      },
      maxConsecutiveErrors: 3,
    });

    loop.start();
    expect(loop.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(loop.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.isRunning()).toBe(true);
    // Third error triggers circuit breaker
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.isRunning()).toBe(false);
  });

  it("defaults to 3 max consecutive errors", async () => {
    const loop = createTypingKeepaliveLoop({
      intervalMs: 50,
      onTick: () => {
        throw new Error("fail");
      },
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(loop.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(loop.isRunning()).toBe(false);
  });

  it("can restart after circuit breaker trips", async () => {
    let shouldFail = true;
    const loop = createTypingKeepaliveLoop({
      intervalMs: 100,
      onTick: () => {
        if (shouldFail) {
          throw new Error("fail");
        }
      },
      maxConsecutiveErrors: 1,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.isRunning()).toBe(false);

    shouldFail = false;
    loop.start();
    expect(loop.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.isRunning()).toBe(true);
    loop.stop();
  });
});
