// Covers fixed-window rate limiter boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixedWindowBudget } from "./fixed-window-rate-limit.js";

afterEach(() => vi.restoreAllMocks());

describe("fixed-window rate limiter", () => {
  it("blocks after max requests until window reset", () => {
    let nowMs = 100;
    const limiter = createFixedWindowBudget({
      maxRequests: 2,
      windowMs: 1_000,
      now: () => nowMs,
    });

    expect(limiter.consume()).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.consume()).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.consume()).toEqual({ allowed: false, retryAfterMs: 1_000 });
    nowMs += 250;
    expect(limiter.consume()).toEqual({ allowed: false, retryAfterMs: 750 });

    nowMs += 750;
    expect(limiter.consume()).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it.each([
    { maxRequests: 0.2, windowMs: 0.4 },
    { maxRequests: Number.NaN, windowMs: Number.POSITIVE_INFINITY },
  ])("clamps required options to at least one: %o", (options) => {
    let nowMs = 100;
    const limiter = createFixedWindowBudget({ ...options, now: () => nowMs });
    expect(limiter.consume()).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.consume()).toEqual({ allowed: false, retryAfterMs: 1 });
    nowMs += 1;
    expect(limiter.consume()).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it.each([-60_000, 60_000])(
    "keeps the default quota on elapsed time after a %ims wall-clock step",
    (step) => {
      let elapsedMs = 100;
      let wallMs = 1_000_000;
      vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
      vi.spyOn(Date, "now").mockImplementation(() => wallMs);
      const limiter = createFixedWindowBudget({ maxRequests: 1, windowMs: 1_000 });
      expect(limiter.consume()).toEqual({ allowed: true, retryAfterMs: 0 });

      elapsedMs += 250;
      wallMs += step;
      expect(limiter.consume()).toEqual({ allowed: false, retryAfterMs: 750 });

      elapsedMs += 750;
      expect(limiter.consume()).toEqual({ allowed: true, retryAfterMs: 0 });
    },
  );
});
