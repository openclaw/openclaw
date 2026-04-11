import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutboundRateLimiter, type OutboundRateLimiter } from "./outbound-rate-limit.js";

describe("outbound rate limiter", () => {
  let limiter: OutboundRateLimiter;

  const CH = "telegram";
  const ALICE = "user:alice";
  const BOB = "user:bob";

  function createLimiter(
    overrides?: Partial<{
      maxMessages: number;
      windowMs: number;
      cooldownMs: number;
      pruneIntervalMs: number;
    }>,
  ) {
    limiter = createOutboundRateLimiter({
      maxMessages: 3,
      windowMs: 60_000,
      cooldownMs: 60_000,
      pruneIntervalMs: 0, // disable auto-prune in tests
      ...overrides,
    });
    return limiter;
  }

  afterEach(() => {
    limiter?.dispose();
    vi.useRealTimers();
  });

  // ---------- basic allow/block ----------

  it("allows messages when no history exists", () => {
    createLimiter();
    expect(limiter.check(CH, ALICE).allowed).toBe(true);
    expect(limiter.check(CH, ALICE).retryAfterMs).toBe(0);
  });

  it("allows messages up to the limit", () => {
    createLimiter({ maxMessages: 3 });
    limiter.record(CH, ALICE);
    limiter.record(CH, ALICE);
    expect(limiter.check(CH, ALICE).allowed).toBe(true);
  });

  it("blocks on the next check once the limit is reached", () => {
    createLimiter({ maxMessages: 3 });
    limiter.record(CH, ALICE);
    limiter.record(CH, ALICE);
    limiter.record(CH, ALICE);
    const result = limiter.check(CH, ALICE);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("retryAfterMs is at most cooldownMs", () => {
    createLimiter({ maxMessages: 2, cooldownMs: 5_000 });
    limiter.record(CH, ALICE);
    limiter.record(CH, ALICE);
    const result = limiter.check(CH, ALICE);
    expect(result.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  // ---------- isolation ----------

  it("limits are independent per recipient", () => {
    createLimiter({ maxMessages: 2 });
    limiter.record(CH, ALICE);
    limiter.record(CH, ALICE);
    // Alice is throttled, Bob should be unaffected.
    expect(limiter.check(CH, ALICE).allowed).toBe(false);
    expect(limiter.check(CH, BOB).allowed).toBe(true);
  });

  it("limits are independent per channel", () => {
    createLimiter({ maxMessages: 2 });
    limiter.record("discord", ALICE);
    limiter.record("discord", ALICE);
    expect(limiter.check("discord", ALICE).allowed).toBe(false);
    expect(limiter.check("telegram", ALICE).allowed).toBe(true);
  });

  // ---------- cool-down expiry ----------

  it("allows sends again after cool-down expires", () => {
    vi.useFakeTimers();
    createLimiter({ maxMessages: 2, windowMs: 10_000, cooldownMs: 5_000 });
    limiter.record(CH, ALICE);
    limiter.record(CH, ALICE);
    expect(limiter.check(CH, ALICE).allowed).toBe(false);

    vi.advanceTimersByTime(6_000); // past cooldownMs
    expect(limiter.check(CH, ALICE).allowed).toBe(true);
  });

  // ---------- sliding window ----------

  it("drops timestamps outside the window", () => {
    vi.useFakeTimers();
    createLimiter({ maxMessages: 3, windowMs: 10_000, cooldownMs: 60_000 });
    limiter.record(CH, ALICE);
    limiter.record(CH, ALICE);

    vi.advanceTimersByTime(11_000); // slide past the window

    // The two old records are expired; should allow two more before blocking.
    limiter.record(CH, ALICE);
    limiter.record(CH, ALICE);
    expect(limiter.check(CH, ALICE).allowed).toBe(true);
  });

  // ---------- size / prune ----------

  it("size() returns the number of tracked pairs", () => {
    createLimiter();
    expect(limiter.size()).toBe(0);
    limiter.record(CH, ALICE);
    limiter.record(CH, BOB);
    expect(limiter.size()).toBe(2);
  });

  it("prune() removes stale entries", () => {
    vi.useFakeTimers();
    createLimiter({ windowMs: 5_000 });
    limiter.record(CH, ALICE);
    expect(limiter.size()).toBe(1);

    vi.advanceTimersByTime(6_000);
    limiter.prune();
    expect(limiter.size()).toBe(0);
  });

  // ---------- dispose ----------

  it("dispose() clears all state", () => {
    createLimiter();
    limiter.record(CH, ALICE);
    limiter.dispose();
    // After dispose, a new check should behave as if nothing was recorded.
    // (We can't call the same instance, but we verify size was cleared.)
    expect(limiter.size()).toBe(0);
  });
});
