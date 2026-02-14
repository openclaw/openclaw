import type { IncomingMessage } from "node:http";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GatewayRateLimiter } from "./rate-limiter.js";

vi.mock("./net.js", () => ({
  resolveGatewayClientIp: vi.fn(({ remoteAddr }: { remoteAddr: string }) => {
    return remoteAddr || undefined;
  }),
}));

function createMockRequest(clientIp = "192.168.1.100"): IncomingMessage {
  return {
    socket: { remoteAddress: clientIp },
    headers: {},
    url: "/test",
  } as IncomingMessage;
}

describe("GatewayRateLimiter", () => {
  let rateLimiter: GatewayRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    rateLimiter = new GatewayRateLimiter({
      auth: {
        maxRequests: 5,
        windowMs: 60_000,
        backoffMultiplier: 2,
        maxBackoffMs: 300_000,
      },
      default: {
        maxRequests: 10,
        windowMs: 60_000,
      },
    });
  });

  afterEach(() => {
    rateLimiter.destroy();
    vi.useRealTimers();
  });

  describe("basic rate limiting", () => {
    it("should allow requests within the limit", () => {
      const req = createMockRequest();
      for (let i = 0; i < 10; i++) {
        const result = rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" });
        expect(result.allowed).toBe(true);
      }
    });

    it("should reject requests exceeding the limit", () => {
      const req = createMockRequest();
      for (let i = 0; i < 10; i++) {
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" });
      }

      const result = rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("rate_limit");
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("should reset rate limit after window expires", () => {
      const req = createMockRequest();
      for (let i = 0; i < 10; i++) {
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" });
      }

      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" }).allowed,
      ).toBe(false);

      vi.advanceTimersByTime(61_000);

      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" }).allowed,
      ).toBe(true);
    });

    it("should track different IPs separately", () => {
      const req1 = createMockRequest("192.168.1.100");
      const req2 = createMockRequest("192.168.1.101");

      for (let i = 0; i < 10; i++) {
        rateLimiter.checkRateLimit({ req: req1, trustedProxies: [], endpoint: "default" });
      }

      expect(
        rateLimiter.checkRateLimit({ req: req1, trustedProxies: [], endpoint: "default" }).allowed,
      ).toBe(false);
      expect(
        rateLimiter.checkRateLimit({ req: req2, trustedProxies: [], endpoint: "default" }).allowed,
      ).toBe(true);
    });
  });

  describe("per-endpoint counters", () => {
    it("should track counters independently per endpoint", () => {
      const req = createMockRequest();

      // Use up auth limit (5)
      for (let i = 0; i < 5; i++) {
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "auth" });
      }
      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "auth" }).allowed,
      ).toBe(false);

      // Default endpoint should still work (separate counter)
      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" }).allowed,
      ).toBe(true);
    });
  });

  describe("authentication backoff", () => {
    it("should apply exponential backoff for failed auth attempts", () => {
      const req = createMockRequest();

      // First failure: 1s backoff (2^0 * 1000ms)
      rateLimiter.recordFailedAuth({ req, trustedProxies: [] });

      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "auth" }).allowed,
      ).toBe(false);

      vi.advanceTimersByTime(1500);
      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "auth" }).allowed,
      ).toBe(true);

      // Second failure: 2s backoff (2^1 * 1000ms)
      rateLimiter.recordFailedAuth({ req, trustedProxies: [] });

      vi.advanceTimersByTime(1500);
      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "auth" }).allowed,
      ).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "auth" }).allowed,
      ).toBe(true);
    });

    it("should reset backoff on successful auth", () => {
      const req = createMockRequest();

      rateLimiter.recordFailedAuth({ req, trustedProxies: [] });
      rateLimiter.recordFailedAuth({ req, trustedProxies: [] });

      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "auth" }).allowed,
      ).toBe(false);

      rateLimiter.resetFailedAuth({ req, trustedProxies: [] });

      expect(
        rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "auth" }).allowed,
      ).toBe(true);
    });

    it("should cap backoff at maximum duration", () => {
      const req = createMockRequest();

      for (let i = 0; i < 20; i++) {
        rateLimiter.recordFailedAuth({ req, trustedProxies: [] });
      }

      const result = rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "auth" });
      expect(result.allowed).toBe(false);
      // maxBackoffMs is 300_000ms = 300s
      expect(result.retryAfter).toBeLessThanOrEqual(300);
    });
  });

  describe("checkAuthBackoff", () => {
    it("should check backoff without incrementing counters", () => {
      const req = createMockRequest();

      rateLimiter.recordFailedAuth({ req, trustedProxies: [] });

      const backoff = rateLimiter.checkAuthBackoff({ req, trustedProxies: [] });
      expect(backoff.allowed).toBe(false);
      expect(backoff.reason).toBe("auth_backoff");

      // Counter should not have been incremented
      const stats = rateLimiter.getClientStats({ req, trustedProxies: [] });
      expect(stats?.count).toBe(0);
    });

    it("should allow when no backoff is active", () => {
      const req = createMockRequest();
      expect(rateLimiter.checkAuthBackoff({ req, trustedProxies: [] }).allowed).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("should clean up expired client states", () => {
      const req1 = createMockRequest("192.168.1.100");
      const req2 = createMockRequest("192.168.1.101");

      rateLimiter.checkRateLimit({ req: req1, trustedProxies: [], endpoint: "default" });
      rateLimiter.checkRateLimit({ req: req2, trustedProxies: [], endpoint: "default" });

      expect(rateLimiter.getClientStats({ req: req1, trustedProxies: [] })).toBeTruthy();
      expect(rateLimiter.getClientStats({ req: req2, trustedProxies: [] })).toBeTruthy();

      // Advance past cleanup threshold (max of windowMs and maxBackoffMs)
      vi.advanceTimersByTime(400_000);

      // Trigger cleanup by making a new request
      rateLimiter.checkRateLimit({
        req: createMockRequest("192.168.1.102"),
        trustedProxies: [],
        endpoint: "default",
      });

      expect(rateLimiter.getClientStats({ req: req1, trustedProxies: [] })).toBeNull();
      expect(rateLimiter.getClientStats({ req: req2, trustedProxies: [] })).toBeNull();
    });
  });

  describe("client stats", () => {
    it("should return null for unknown clients", () => {
      const req = createMockRequest();
      expect(rateLimiter.getClientStats({ req, trustedProxies: [] })).toBeNull();
    });

    it("should return aggregate stats after requests", () => {
      const req = createMockRequest();

      rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" });

      const stats = rateLimiter.getClientStats({ req, trustedProxies: [] });
      expect(stats).toBeTruthy();
      expect(stats!.count).toBe(1);
      expect(stats!.failedAuthAttempts).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("should allow requests when client IP cannot be determined", () => {
      const req = { socket: {}, headers: {}, url: "/test" } as IncomingMessage;

      const result = rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" });
      expect(result.allowed).toBe(true);
    });

    it("should handle destroy gracefully", () => {
      const req = createMockRequest();

      rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" });
      expect(() => rateLimiter.destroy()).not.toThrow();

      // Should still work after destroy (state cleared, cleanup stopped)
      const result = rateLimiter.checkRateLimit({ req, trustedProxies: [], endpoint: "default" });
      expect(result.allowed).toBe(true);
    });
  });
});
