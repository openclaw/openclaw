import { afterEach, describe, expect, it, vi } from "vitest";
import { createRetryRunner } from "../../packages/retry/src/index.js";

const TIMER_MAX_MS = 2_147_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("retry scheduler long native waits", () => {
  it("does not retry until every chunk of a long Retry-After has elapsed", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const operation = vi.fn().mockRejectedValueOnce(new Error("retryable")).mockResolvedValue("ok");
    const onRetry = vi.fn();
    const delayMs = 2 * TIMER_MAX_MS + 123;
    const result = createRetryRunner()(operation, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      retryAfterMs: () => delayMs,
      onRetry,
    });
    await vi.advanceTimersByTimeAsync(TIMER_MAX_MS);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TIMER_MAX_MS);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(122);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(timer.mock.calls.map((call) => call[1])).toEqual([TIMER_MAX_MS, TIMER_MAX_MS, 123]);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs }));
  });

  it("splits a jitter-expanded delay instead of clipping the policy result", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const operation = vi.fn().mockRejectedValueOnce(new Error("retryable")).mockResolvedValue("ok");
    const result = createRetryRunner()(operation, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      delayMs: TIMER_MAX_MS,
      jitter: "full",
      random: () => 1,
    });
    await vi.advanceTimersByTimeAsync(TIMER_MAX_MS);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TIMER_MAX_MS);
    await expect(result).resolves.toBe("ok");
    expect(timer.mock.calls.map((call) => call[1])).toEqual([TIMER_MAX_MS, TIMER_MAX_MS]);
  });

  it("keeps short native waits and the numeric zero-delay yield", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    for (const delay of [0, 10]) {
      timer.mockClear();
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error("retryable"))
        .mockResolvedValue("ok");
      const result = createRetryRunner()(operation, 2, delay);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("ok");
      expect(timer.mock.calls.map((call) => call[1])).toEqual([delay]);
    }
  });

  it("does not split or shorten an explicitly supplied sleep implementation", async () => {
    const delayMs = 2 * TIMER_MAX_MS + 123;
    const sleep = vi.fn(async (_ms: number) => undefined);
    const operation = vi.fn().mockRejectedValueOnce(new Error("retryable")).mockResolvedValue("ok");
    await createRetryRunner()(operation, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      retryAfterMs: () => delayMs,
      sleep,
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(delayMs);
  });

  it("preserves a caller's explicit delay cap and terminal error identity", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const failure = new Error("terminal");
    await expect(
      createRetryRunner({ sleep })(
        async () => {
          throw failure;
        },
        {
          attempts: 2,
          minDelayMs: 0,
          maxDelayMs: 500,
          retryAfterMs: () => 10_000,
        },
      ),
    ).rejects.toBe(failure);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("never schedules a timer when retry is refused", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const failure = new Error("non-retryable");
    const operation = vi.fn().mockRejectedValue(failure);
    await expect(
      createRetryRunner({ sleep })(operation, {
        attempts: 2,
        shouldRetry: () => false,
      }),
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
