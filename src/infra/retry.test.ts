import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRetryConfig, retryAsync } from "./retry.js";

async function runRetryAfterCase(params: {
  minDelayMs: number;
  maxDelayMs: number;
  retryAfterMs: number;
}): Promise<number[]> {
  vi.clearAllTimers();
  vi.useFakeTimers();
  try {
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const delays: number[] = [];
    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: params.minDelayMs,
      maxDelayMs: params.maxDelayMs,
      jitter: 0,
      retryAfterMs: () => params.retryAfterMs,
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    return delays;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("retryAsync", () => {
  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryAsync(fn, 3, 10);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("fail1")).mockResolvedValueOnce("ok");
    const result = await retryAsync(fn, 3, 1);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retryAsync(fn, 2, 1)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops when shouldRetry returns false", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);
    const shouldRetry = vi.fn(() => false);
    await expect(retryAsync(fn, { attempts: 3, shouldRetry })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(err, 1);
  });

  it("calls onRetry with retry metadata before retrying", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    const res = await retryAsync(fn, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      label: "telegram",
      onRetry,
    });
    expect(res).toBe("ok");
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 2,
        err,
        label: "telegram",
      }),
    );
  });

  it("clamps attempts to at least 1", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retryAsync(fn, { attempts: 0, minDelayMs: 0, maxDelayMs: 0 })).rejects.toThrow(
      "boom",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses retryAfterMs when provided", async () => {
    const delays = await runRetryAfterCase({ minDelayMs: 0, maxDelayMs: 1000, retryAfterMs: 500 });
    expect(delays[0]).toBe(500);
  });

  it("clamps retryAfterMs to maxDelayMs", async () => {
    const delays = await runRetryAfterCase({ minDelayMs: 0, maxDelayMs: 100, retryAfterMs: 500 });
    expect(delays[0]).toBe(100);
  });

  it("clamps retryAfterMs to minDelayMs", async () => {
    const delays = await runRetryAfterCase({ minDelayMs: 250, maxDelayMs: 1000, retryAfterMs: 50 });
    expect(delays[0]).toBe(250);
  });
});

describe("resolveRetryConfig", () => {
  it.each([
    {
      name: "rounds attempts and delays",
      overrides: { attempts: 2.6, minDelayMs: 10.4, maxDelayMs: 99.8, jitter: 0.4 },
      expected: { attempts: 3, minDelayMs: 10, maxDelayMs: 100, jitter: 0.4 },
    },
    {
      name: "clamps attempts to at least one and maxDelayMs to minDelayMs",
      overrides: { attempts: 0, minDelayMs: 250, maxDelayMs: 100, jitter: -1 },
      expected: { attempts: 1, minDelayMs: 250, maxDelayMs: 250, jitter: 0 },
    },
    {
      name: "falls back for non-finite overrides and caps jitter at one",
      overrides: {
        attempts: Number.NaN,
        minDelayMs: Number.POSITIVE_INFINITY,
        maxDelayMs: Number.NaN,
        jitter: 2,
      },
      expected: { attempts: 3, minDelayMs: 300, maxDelayMs: 30000, jitter: 1 },
    },
  ])("$name", ({ overrides, expected }) => {
    expect(resolveRetryConfig(undefined, overrides)).toEqual(expected);
  });
});
