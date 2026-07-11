import { describe, expect, it } from "vitest";
import { resolveAutoRetryDelayMs } from "./retry.js";

const MAX = 60_000; // retry.provider.maxRetryDelayMs default

describe("resolveAutoRetryDelayMs", () => {
  it("falls back to pure exponential backoff when no Retry-After is present", () => {
    expect(resolveAutoRetryDelayMs({ attempt: 1, baseDelayMs: 2000, maxRetryDelayMs: MAX })).toBe(
      2000,
    );
    expect(resolveAutoRetryDelayMs({ attempt: 2, baseDelayMs: 2000, maxRetryDelayMs: MAX })).toBe(
      4000,
    );
    expect(resolveAutoRetryDelayMs({ attempt: 3, baseDelayMs: 2000, maxRetryDelayMs: MAX })).toBe(
      8000,
    );
  });

  it("uses the server Retry-After as a lower bound when it exceeds the exponential delay", () => {
    // 30s server cooldown on the first attempt (exponential would be 2s), within the 60s max.
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        maxRetryDelayMs: MAX,
        retryAfterSeconds: 30,
      }),
    ).toBe(30_000);
  });

  it("keeps the exponential delay when it already exceeds the server Retry-After", () => {
    // attempt 3 -> exponential 8s dominates a 1s hint.
    expect(
      resolveAutoRetryDelayMs({
        attempt: 3,
        baseDelayMs: 2000,
        maxRetryDelayMs: MAX,
        retryAfterSeconds: 1,
      }),
    ).toBe(8000);
  });

  it("honors a server Retry-After exactly at the configured maximum", () => {
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        maxRetryDelayMs: MAX,
        retryAfterSeconds: 60,
      }),
    ).toBe(60_000);
  });

  it("rejects (returns null) a server Retry-After above the configured maximum", () => {
    // 120s cooldown exceeds the 60s max -> caller should stop retrying (fallback), not sleep 2m.
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        maxRetryDelayMs: MAX,
        retryAfterSeconds: 120,
      }),
    ).toBeNull();
    // An overflowed/never-ending header (canonical parser yields Infinity) is also rejected.
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        maxRetryDelayMs: MAX,
        retryAfterSeconds: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });

  it("honors longer server cooldowns when the operator raises the configured maximum", () => {
    // With a 10-minute configured max, a 120s cooldown is accepted in full (not shortened).
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        maxRetryDelayMs: 600_000,
        retryAfterSeconds: 120,
      }),
    ).toBe(120_000);
  });

  it("ignores invalid Retry-After values and uses the exponential delay", () => {
    expect(
      resolveAutoRetryDelayMs({
        attempt: 2,
        baseDelayMs: 2000,
        maxRetryDelayMs: MAX,
        retryAfterSeconds: Number.NaN,
      }),
    ).toBe(4000);
    expect(
      resolveAutoRetryDelayMs({
        attempt: 2,
        baseDelayMs: 2000,
        maxRetryDelayMs: MAX,
        retryAfterSeconds: -5,
      }),
    ).toBe(4000);
    expect(
      resolveAutoRetryDelayMs({
        attempt: 2,
        baseDelayMs: 2000,
        maxRetryDelayMs: MAX,
        retryAfterSeconds: 0,
      }),
    ).toBe(4000);
  });
});
