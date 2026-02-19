import { describe, expect, it } from "vitest";
import { createFixedWindowRateLimiter } from "./fixed-window-rate-limit.js";

describe("fixed-window rate limiter", () => {
  it("blocks after max requests until window reset", () => {
    let nowMs = 1_000;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 1_000,
      now: () => nowMs,
    });

    expect(limiter.consume()).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume()).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume()).toMatchObject({ allowed: false, retryAfterMs: 1_000 });

    nowMs += 1_000;
    expect(limiter.consume()).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("supports explicit reset", () => {
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 10_000,
    });
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(false);
    limiter.reset();
    expect(limiter.consume().allowed).toBe(true);
  });
});
