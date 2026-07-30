// Covers retry backoff calculation and abortable sleep behavior.
import { describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "./backoff.js";

async function expectAbortedSleep(promise: Promise<void>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected aborted sleep");
}

describe("backoff helpers", () => {
  const policy: BackoffPolicy = {
    initialMs: 100,
    maxMs: 250,
    factor: 2,
    jitter: 0.5,
  };

  it("treats attempts below one as the first backoff step", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(computeBackoff(policy, 0)).toBe(100);
      expect(computeBackoff(policy, 1)).toBe(100);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("adds jitter and clamps to maxMs", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      expect(computeBackoff(policy, 2)).toBe(250);
      expect(computeBackoff({ ...policy, maxMs: 450 }, 2)).toBe(300);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("returns immediately for non-positive sleep durations", async () => {
    await expect(sleepWithAbort(0, AbortSignal.abort())).resolves.toBeUndefined();
    await expect(sleepWithAbort(-5)).resolves.toBeUndefined();
  });

  it("wraps aborted sleeps with a stable aborted error", async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await expectAbortedSleep(sleepWithAbort(5, controller.signal));
    expect(error.message).toBe("aborted");
    expect(error.cause).toBe(controller.signal.reason);
  });

  it("advances with fake timers", async () => {
    vi.useFakeTimers();
    try {
      const sleeper = sleepWithAbort(50);
      await vi.advanceTimersByTimeAsync(49);
      await expect(
        Promise.race([sleeper.then(() => "done"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await expect(sleeper).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the abort listener after the sleep completes", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(controller.signal, "removeEventListener");
    try {
      const sleeper = sleepWithAbort(50, controller.signal);
      const abortListener = addEventListenerSpy.mock.calls[0]?.[1];

      expect(abortListener).toBeDefined();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      await expect(sleeper).resolves.toBeUndefined();

      expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", abortListener);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("clears the timer and listener when aborted during the sleep", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(controller.signal, "removeEventListener");
    try {
      const sleeper = sleepWithAbort(50, controller.signal);
      const rejectedSleep = expectAbortedSleep(sleeper);
      const abortListener = addEventListenerSpy.mock.calls[0]?.[1];

      expect(abortListener).toBeDefined();
      expect(vi.getTimerCount()).toBe(1);
      controller.abort(new Error("stop retrying"));

      const error = await rejectedSleep;
      expect(error.message).toBe("aborted");
      expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", abortListener);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("clamps oversized sleep durations before scheduling", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const sleeper = sleepWithAbort(Number.MAX_SAFE_INTEGER);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
      await expect(sleeper).resolves.toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("produces spread values when jitter is non-zero", () => {
    // Validates that non-zero jitter breaks synchronization across identical
    // backoff attempts — the property that prevents thundering herd on
    // gateway restart when many workers share the same default backoff.
    const workerPolicy: BackoffPolicy = {
      initialMs: 250,
      maxMs: 30_000,
      factor: 2,
      jitter: 0.1,
    };
    const randomSpy = vi.spyOn(Math, "random");
    try {
      randomSpy.mockReturnValue(0);
      const min = computeBackoff(workerPolicy, 1);
      randomSpy.mockReturnValue(1);
      const max = computeBackoff(workerPolicy, 1);
      expect(min).toBe(250);
      expect(max).toBe(275);
      expect(max).toBeGreaterThan(min);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("positive jitter is clamped away at the cap, reconverging workers", () => {
    // Documents the shared-helper limitation that motivates the per-connection
    // phase offset in WorkerConnection: once base >= maxMs, positive-only
    // jitter is fully clamped and all callers get the same capped value.
    const workerPolicy: BackoffPolicy = {
      initialMs: 250,
      maxMs: 30_000,
      factor: 2,
      jitter: 0.1,
    };
    const randomSpy = vi.spyOn(Math, "random");
    try {
      randomSpy.mockReturnValue(0);
      const atCapMin = computeBackoff(workerPolicy, 8);
      randomSpy.mockReturnValue(1);
      const atCapMax = computeBackoff(workerPolicy, 8);
      expect(atCapMin).toBe(30_000);
      expect(atCapMax).toBe(30_000);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("rejects if the signal aborts during listener registration", async () => {
    let aborted = false;
    const signal = {
      get aborted() {
        return aborted;
      },
      get reason() {
        return new Error("listener-registration-race");
      },
      addEventListener(_eventValue: string, _listener: EventListenerOrEventListenerObject) {
        aborted = true;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;

    const error = await expectAbortedSleep(sleepWithAbort(50, signal));
    expect(error.message).toBe("aborted");
    expect(error.cause).toStrictEqual(new Error("listener-registration-race"));
  });
});
