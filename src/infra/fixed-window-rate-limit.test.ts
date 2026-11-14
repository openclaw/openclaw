// Covers fixed-window rate limiter boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixedWindowBudget } from "./fixed-window-rate-limit.js";

afterEach(() => vi.restoreAllMocks());

function expectConsumeResult(
  result: { allowed: boolean; retryAfterMs: number },
  expected: { allowed: boolean; retryAfterMs: number },
): void {
  expect(result.allowed).toBe(expected.allowed);
  expect(result.retryAfterMs).toBe(expected.retryAfterMs);
}

describe("fixed-window rate limiter", () => {
  it("blocks after max requests until window reset", () => {
    let nowMs = 100;
    const limiter = createFixedWindowBudget({
      maxRequests: 2,
      windowMs: 1_000,
      now: () => nowMs,
    });

    expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });
    expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });
    expectConsumeResult(limiter.consume(), { allowed: false, retryAfterMs: 1_000 });

    nowMs += 1_000;
    expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });
  });

  it("clamps maxRequests and windowMs to at least one", () => {
    let nowMs = 100;
    const limiter = createFixedWindowBudget({
      maxRequests: 0.2,
      windowMs: 0.4,
      now: () => nowMs,
    });

    expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });
    expectConsumeResult(limiter.consume(), { allowed: false, retryAfterMs: 1 });

    nowMs += 1;
    expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });
  });

  it("falls back to minimums for non-finite required values", () => {
    let nowMs = 100;
    const limiter = createFixedWindowBudget({
      maxRequests: Number.NaN,
      windowMs: Number.POSITIVE_INFINITY,
      now: () => nowMs,
    });

    expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });
    expectConsumeResult(limiter.consume(), { allowed: false, retryAfterMs: 1 });

    nowMs += 1;
    expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });
  });

  it("reports the remaining retry window after later blocked attempts", () => {
    let nowMs = 1_000;
    const limiter = createFixedWindowBudget({
      maxRequests: 1,
      windowMs: 1_000,
      now: () => nowMs,
    });

    expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });

    nowMs += 250;
    expectConsumeResult(limiter.consume(), { allowed: false, retryAfterMs: 750 });
  });

  it.each([-60_000, 60_000])(
    "keeps the default quota on elapsed time after a %ims wall-clock step",
    (step) => {
      let elapsedMs = 100;
      let wallMs = 1_000_000;
      vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
      vi.spyOn(Date, "now").mockImplementation(() => wallMs);
      const limiter = createFixedWindowBudget({ maxRequests: 1, windowMs: 1_000 });
      expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });

      elapsedMs += 250;
      wallMs += step;
      expectConsumeResult(limiter.consume(), { allowed: false, retryAfterMs: 750 });

      elapsedMs += 750;
      expectConsumeResult(limiter.consume(), { allowed: true, retryAfterMs: 0 });
    },
  );
});
