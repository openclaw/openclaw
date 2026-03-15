import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";

describe("createTypingKeepaliveLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops after consecutive errors exceed threshold", async () => {
    const onTick = vi.fn().mockRejectedValue(new Error("network error"));
    const loop = createTypingKeepaliveLoop({
      intervalMs: 100,
      onTick,
      maxConsecutiveErrors: 3,
    });

    loop.start();
    expect(loop.isRunning()).toBe(true);

    // Trigger 3 ticks that all fail
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
    }

    expect(loop.isRunning()).toBe(false);
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it("resets consecutive error count on success", async () => {
    let callCount = 0;
    const onTick = vi.fn().mockImplementation(async () => {
      callCount++;
      // Fail on calls 1-2, succeed on 3
      if (callCount <= 2) {
        throw new Error("network error");
      }
    });
    const loop = createTypingKeepaliveLoop({
      intervalMs: 100,
      onTick,
      maxConsecutiveErrors: 3,
    });

    loop.start();

    // Tick 1: fail (consecutive=1)
    await loop.tick();
    expect(loop.isRunning()).toBe(true);

    // Tick 2: fail (consecutive=2)
    await loop.tick();
    expect(loop.isRunning()).toBe(true);

    // Tick 3: success (consecutive=0)
    await loop.tick();
    expect(loop.isRunning()).toBe(true);

    // Now make all subsequent fail again
    onTick.mockRejectedValue(new Error("network error"));

    // Tick 4: fail (consecutive=1)
    await loop.tick();
    expect(loop.isRunning()).toBe(true);

    // Tick 5: fail (consecutive=2)
    await loop.tick();
    expect(loop.isRunning()).toBe(true);

    // Tick 6: fail (consecutive=3) → circuit break
    await loop.tick();
    expect(loop.isRunning()).toBe(false);

    loop.stop();
  });

  it("defaults to 3 consecutive errors", async () => {
    const onTick = vi.fn().mockRejectedValue(new Error("network error"));
    const loop = createTypingKeepaliveLoop({
      intervalMs: 100,
      onTick,
    });

    loop.start();

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
    }

    expect(loop.isRunning()).toBe(false);
  });
});
