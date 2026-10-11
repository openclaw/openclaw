// Covers retry error history and secure jitter at the core adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRetryAttemptErrors } from "./retry-attempt-errors.js";
import { retryAsync } from "./retry.js";

const randomMocks = vi.hoisted(() => ({
  generateSecureFraction: vi.fn(),
}));

vi.mock("./secure-random.js", () => ({
  generateSecureFraction: randomMocks.generateSecureFraction,
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  randomMocks.generateSecureFraction.mockReset();
});

describe("retryAsync", () => {
  it("retains every failed attempt without replacing the terminal error", async () => {
    const firstError = new Error("first");
    const terminalError = new Error("terminal");
    const fn = vi.fn().mockRejectedValueOnce(firstError).mockRejectedValueOnce(terminalError);

    const failure = await retryAsync(fn, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
    }).catch((err: unknown) => err);

    expect(failure).toBe(terminalError);
    expect(getRetryAttemptErrors(failure)).toEqual([firstError, terminalError]);
  });

  it("uses secure jitter when configured", async () => {
    vi.useFakeTimers();
    randomMocks.generateSecureFraction.mockReturnValue(1);
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const delays: number[] = [];

    try {
      const promise = retryAsync(fn, {
        attempts: 2,
        minDelayMs: 100,
        maxDelayMs: 200,
        jitter: 0.5,
        onRetry: (info) => delays.push(info.delayMs),
      });
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe("ok");
      expect(delays).toEqual([150]);
      expect(randomMocks.generateSecureFraction).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
