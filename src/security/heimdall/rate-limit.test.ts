import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HeimdallRateLimiter, __resetRateLimiter, getHeimdallRateLimiter } from "./rate-limit.js";
import { SenderTier } from "./types.js";

describe("HeimdallRateLimiter", () => {
  let limiter: HeimdallRateLimiter;

  beforeEach(() => {
    __resetRateLimiter();
  });

  afterEach(() => {
    limiter?.destroy();
    __resetRateLimiter();
  });

  describe("basic operation", () => {
    it("allows messages under limit", () => {
      limiter = new HeimdallRateLimiter({
        enabled: true,
        windowMs: 60_000,
        maxMessages: 5,
      });
      const result = limiter.check("user1", SenderTier.MEMBER);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it("blocks messages over limit", () => {
      limiter = new HeimdallRateLimiter({
        enabled: true,
        windowMs: 60_000,
        maxMessages: 3,
      });
      for (let i = 0; i < 3; i++) {
        expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(true);
      }
      const result = limiter.check("user1", SenderTier.MEMBER);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.resetMs).toBeGreaterThan(0);
    });

    it("OWNER is never rate-limited", () => {
      limiter = new HeimdallRateLimiter({
        enabled: true,
        windowMs: 60_000,
        maxMessages: 1,
      });
      // First call fills the limit
      limiter.check("owner1", SenderTier.MEMBER);
      // Owner bypasses
      for (let i = 0; i < 100; i++) {
        const result = limiter.check("owner1", SenderTier.OWNER);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(Infinity);
      }
    });
  });

  describe("GUEST vs MEMBER limits", () => {
    it("uses guestMaxMessages for GUEST", () => {
      limiter = new HeimdallRateLimiter({
        enabled: true,
        windowMs: 60_000,
        maxMessages: 10,
        guestMaxMessages: 2,
      });
      expect(limiter.check("guest1", SenderTier.GUEST).allowed).toBe(true);
      expect(limiter.check("guest1", SenderTier.GUEST).allowed).toBe(true);
      expect(limiter.check("guest1", SenderTier.GUEST).allowed).toBe(false);
    });

    it("uses maxMessages for MEMBER", () => {
      limiter = new HeimdallRateLimiter({
        enabled: true,
        windowMs: 60_000,
        maxMessages: 3,
        guestMaxMessages: 1,
      });
      expect(limiter.check("member1", SenderTier.MEMBER).allowed).toBe(true);
      expect(limiter.check("member1", SenderTier.MEMBER).allowed).toBe(true);
      expect(limiter.check("member1", SenderTier.MEMBER).allowed).toBe(true);
      expect(limiter.check("member1", SenderTier.MEMBER).allowed).toBe(false);
    });
  });

  describe("sliding window", () => {
    it("messages expire after window elapses", () => {
      vi.useFakeTimers();
      try {
        limiter = new HeimdallRateLimiter({
          enabled: true,
          windowMs: 1000,
          maxMessages: 2,
        });
        expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(true);
        expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(true);
        expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(false);

        // Advance past window
        vi.advanceTimersByTime(1001);

        // Should be allowed again
        expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("window resets correctly for partial expiry", () => {
      vi.useFakeTimers();
      try {
        limiter = new HeimdallRateLimiter({
          enabled: true,
          windowMs: 1000,
          maxMessages: 2,
        });
        // t=0: first message
        limiter.check("user1", SenderTier.MEMBER);
        // t=500: second message
        vi.advanceTimersByTime(500);
        limiter.check("user1", SenderTier.MEMBER);
        // t=500: should be blocked
        expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(false);
        // t=1001: first message expired, one slot free
        vi.advanceTimersByTime(501);
        expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(true);
        // Still blocked (second + new messages fill limit)
        expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("multiple senders", () => {
    it("senders are independent", () => {
      limiter = new HeimdallRateLimiter({
        enabled: true,
        windowMs: 60_000,
        maxMessages: 1,
      });
      expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(true);
      expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(false);
      // Different sender is independent
      expect(limiter.check("user2", SenderTier.MEMBER).allowed).toBe(true);
      expect(limiter.check("user2", SenderTier.MEMBER).allowed).toBe(false);
    });
  });

  describe("default config values", () => {
    it("uses defaults when not specified", () => {
      limiter = new HeimdallRateLimiter({ enabled: true });
      // Should allow up to 30 messages (default maxMessages)
      for (let i = 0; i < 30; i++) {
        expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(true);
      }
      expect(limiter.check("user1", SenderTier.MEMBER).allowed).toBe(false);
    });

    it("guest default is 5", () => {
      limiter = new HeimdallRateLimiter({ enabled: true });
      for (let i = 0; i < 5; i++) {
        expect(limiter.check("guest1", SenderTier.GUEST).allowed).toBe(true);
      }
      expect(limiter.check("guest1", SenderTier.GUEST).allowed).toBe(false);
    });
  });

  describe("singleton", () => {
    it("getHeimdallRateLimiter returns null when disabled", () => {
      expect(getHeimdallRateLimiter(undefined)).toBeNull();
      expect(getHeimdallRateLimiter({ enabled: false })).toBeNull();
    });

    it("getHeimdallRateLimiter returns instance when enabled", () => {
      const instance = getHeimdallRateLimiter({ enabled: true });
      expect(instance).toBeInstanceOf(HeimdallRateLimiter);
      instance?.destroy();
    });
  });
});
