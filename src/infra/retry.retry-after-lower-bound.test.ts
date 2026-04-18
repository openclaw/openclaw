// Regression: retryAsync's symmetric jitter violated server-supplied
// Retry-After as a lower bound. When `retryAfterMs` returned a finite value
// (for example from a 429/503 with a Retry-After header), the code went:
//
//   baseDelay = max(retryAfterMs, minDelayMs)
//   delay = min(baseDelay, maxDelayMs)
//   delay = applyJitter(delay, jitter)          // (-jitter .. +jitter) !!
//   delay = min(max(delay, minDelayMs), maxDelayMs)
//
// The `applyJitter` call used a symmetric window, so roughly half the
// retries landed at baseDelay * (1 - jitter) < retryAfterMs. The final clamp
// only restored the local minDelayMs floor, not the server's Retry-After
// value, so concurrent clients could retry before the rate limiter's hint —
// the exact anti-pattern Retry-After exists to avoid.
//
// Fix: when retryAfterMs is in effect, use positive-only jitter so the delay
// never drops below the server-supplied lower bound.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("retryAsync respects server-supplied Retry-After as a lower bound", () => {
  it("never schedules a delay below retryAfterMs even at the low end of jitter", async () => {
    // fraction = 0 is the adversarial case: symmetric jitter yields -jitter,
    // i.e. delay = base * (1 - jitter), which would violate the Retry-After
    // lower bound. Positive jitter keeps delay = base (no change).
    randomMocks.generateSecureFraction.mockReturnValue(0);

    vi.useFakeTimers();
    const delays: number[] = [];
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("429 retry-after"))
      .mockResolvedValueOnce("ok");

    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: 1,
      maxDelayMs: 60_000,
      jitter: 0.5,
      retryAfterMs: () => 1_000,
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");

    expect(delays).toHaveLength(1);
    // The critical assertion: the scheduled delay must not undercut the
    // server-supplied Retry-After even on the low end of the jitter window.
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
  });
});
