import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWsConnectionRateLimiter } from "./ws-rate-limit.js";

describe("ws-rate-limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows messages within the limit", () => {
    const limiter = createWsConnectionRateLimiter({ maxMessages: 5, windowMs: 1000 });
    for (let i = 0; i < 5; i++) {
      const result = limiter.hit();
      expect(result.allowed).toBe(true);
      expect(result.shouldClose).toBe(false);
    }
  });

  it("blocks messages exceeding the limit", () => {
    const limiter = createWsConnectionRateLimiter({ maxMessages: 3, windowMs: 1000 });
    limiter.hit();
    limiter.hit();
    limiter.hit();
    const result = limiter.hit();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.warnings).toBe(1);
  });

  it("closes connection after maxWarnings exceeded", () => {
    const limiter = createWsConnectionRateLimiter({
      maxMessages: 2,
      windowMs: 1000,
      maxWarnings: 3,
    });
    // Fill the window
    limiter.hit();
    limiter.hit();
    // 3 over-limit hits = 3 warnings
    limiter.hit(); // warning 1
    limiter.hit(); // warning 2
    const result = limiter.hit(); // warning 3
    expect(result.shouldClose).toBe(true);
    expect(result.warnings).toBe(3);
  });

  it("resets state and allows traffic again", () => {
    const limiter = createWsConnectionRateLimiter({ maxMessages: 2, windowMs: 1000 });
    limiter.hit();
    limiter.hit();
    const blocked = limiter.hit();
    expect(blocked.allowed).toBe(false);

    limiter.reset();
    const afterReset = limiter.hit();
    expect(afterReset.allowed).toBe(true);
    expect(limiter.warningCount()).toBe(0);
  });

  it("sliding window expires old messages", () => {
    const limiter = createWsConnectionRateLimiter({ maxMessages: 3, windowMs: 1000 });
    limiter.hit();
    limiter.hit();
    limiter.hit();
    // Window is full
    const blocked = limiter.hit();
    expect(blocked.allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(1100);
    const afterWindow = limiter.hit();
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.remaining).toBe(2);
  });

  it("returns correct remaining count", () => {
    const limiter = createWsConnectionRateLimiter({ maxMessages: 5, windowMs: 1000 });
    expect(limiter.hit().remaining).toBe(4);
    expect(limiter.hit().remaining).toBe(3);
    expect(limiter.hit().remaining).toBe(2);
  });

  it("uses default configuration", () => {
    const limiter = createWsConnectionRateLimiter();
    // Should allow 100 messages in 10s window by default
    for (let i = 0; i < 100; i++) {
      expect(limiter.hit().allowed).toBe(true);
    }
    expect(limiter.hit().allowed).toBe(false);
  });
});
