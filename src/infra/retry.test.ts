import { afterEach, describe, expect, it, vi } from "vitest";
import { retryAsync } from "./retry.js";
import { isAbortError } from "./unhandled-rejections.js";

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
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retryAsync(fn, { attempts: 3, shouldRetry: () => false })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry before retrying", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    const res = await retryAsync(fn, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      onRetry,
    });
    expect(res).toBe("ok");
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, maxAttempts: 2 }));
  });

  it("clamps attempts to at least 1", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retryAsync(fn, { attempts: 0, minDelayMs: 0, maxDelayMs: 0 })).rejects.toThrow(
      "boom",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses retryAfterMs when provided", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const delays: number[] = [];
    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 1000,
      jitter: 0,
      retryAfterMs: () => 500,
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(delays[0]).toBe(500);
    vi.useRealTimers();
  });

  it("clamps retryAfterMs to maxDelayMs", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const delays: number[] = [];
    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 100,
      jitter: 0,
      retryAfterMs: () => 500,
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(delays[0]).toBe(100);
    vi.useRealTimers();
  });
});

describe("retryAsync with AbortSignal", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("aborts during backoff sleep immediately without further attempts", async () => {
    const ac = new AbortController();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("success");

    // Start retry with a long backoff; abort after a short real delay
    const promise = retryAsync(fn, {
      attempts: 3,
      minDelayMs: 10_000,
      maxDelayMs: 30_000,
      jitter: 0,
      signal: ac.signal,
    });

    // Give the first fn() call time to fail and start the backoff sleep
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    // Abort while sleeping; sleepWithAbort should reject immediately
    ac.abort();

    await expect(promise).rejects.toSatisfy(isAbortError);
    // fn was called exactly once — abort interrupted sleep before second attempt
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("skips fn() if signal is already aborted before first attempt", async () => {
    const ac = new AbortController();
    ac.abort();

    const fn = vi.fn<() => Promise<string>>().mockResolvedValue("success");

    await expect(
      retryAsync(fn, {
        attempts: 3,
        minDelayMs: 0,
        maxDelayMs: 0,
        signal: ac.signal,
      }),
    ).rejects.toSatisfy(isAbortError);

    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("retries normally for non-abort errors when signal is not fired", async () => {
    const ac = new AbortController();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("err1"))
      .mockRejectedValueOnce(new Error("err2"))
      .mockResolvedValueOnce("ok");

    const result = await retryAsync(fn, {
      attempts: 3,
      minDelayMs: 0,
      maxDelayMs: 0,
      jitter: 0,
      signal: ac.signal,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
