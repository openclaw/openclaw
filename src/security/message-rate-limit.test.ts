import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRateLimitKey,
  createMessageRateLimiter,
  type MessageRateLimiter,
} from "./message-rate-limit.js";

describe("message-rate-limit", () => {
  let limiter: MessageRateLimiter;

  afterEach(() => {
    limiter?.dispose();
  });

  describe("buildRateLimitKey", () => {
    it("builds composite key from identity", () => {
      expect(
        buildRateLimitKey({ channel: "whatsapp", accountId: "default", senderId: "+1234567890" }),
      ).toBe("whatsapp:default:+1234567890");
    });

    it("appends sessionKey when provided", () => {
      expect(
        buildRateLimitKey({
          channel: "discord",
          accountId: "main",
          senderId: "user123",
          sessionKey: "sess-abc",
        }),
      ).toBe("discord:main:user123:sess-abc");
    });
  });

  describe("under limit", () => {
    it("allows 5 messages in 1 minute", () => {
      limiter = createMessageRateLimiter({ pruneIntervalMs: 0 });
      const key = "whatsapp:default:sender1";
      for (let i = 0; i < 5; i++) {
        const result = limiter.check(key);
        expect(result.allowed).toBe(true);
        limiter.record(key);
      }
    });
  });

  describe("burst detection", () => {
    it("throttles after burst limit in 10 s window", () => {
      limiter = createMessageRateLimiter({
        burstLimit: 5,
        pruneIntervalMs: 0,
      });
      const key = "telegram:default:sender2";

      // Record 5 messages (burst limit = 5)
      for (let i = 0; i < 5; i++) {
        limiter.record(key);
      }

      const result = limiter.check(key);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("burst");
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe("per-minute limit", () => {
    it("throttles 21st message in 1 minute (default=20)", () => {
      limiter = createMessageRateLimiter({
        maxMessagesPerMinute: 20,
        burstLimit: 100, // disable burst for this test
        pruneIntervalMs: 0,
      });
      const key = "discord:default:sender3";

      for (let i = 0; i < 20; i++) {
        limiter.record(key);
      }

      const result = limiter.check(key);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("per-minute");
    });
  });

  describe("per-hour limit", () => {
    it("throttles 201st message spread over 59 minutes (default=200)", () => {
      vi.useFakeTimers();
      try {
        limiter = createMessageRateLimiter({
          maxMessagesPerHour: 200,
          maxMessagesPerMinute: 1000, // disable per-minute for this test
          burstLimit: 1000, // disable burst for this test
          pruneIntervalMs: 0,
        });
        const key = "slack:default:sender4";

        // Spread 200 messages over ~59 minutes
        for (let i = 0; i < 200; i++) {
          limiter.record(key);
          vi.advanceTimersByTime(17_700); // ~59 min total
        }

        const result = limiter.check(key);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe("per-hour");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cooldown", () => {
    it("rejects messages during cooldown period after burst", () => {
      limiter = createMessageRateLimiter({
        burstLimit: 3,
        cooldownMs: 5000,
        pruneIntervalMs: 0,
      });
      const key = "signal:default:sender5";

      for (let i = 0; i < 3; i++) {
        limiter.record(key);
      }

      // Triggers burst → cooldown
      const burstResult = limiter.check(key);
      expect(burstResult.allowed).toBe(false);
      expect(burstResult.reason).toBe("burst");

      // During cooldown, messages are still rejected
      const cooldownResult = limiter.check(key);
      expect(cooldownResult.allowed).toBe(false);
      expect(cooldownResult.reason).toBe("cooldown");
    });

    it("allows messages after cooldown period expires and burst window elapses", () => {
      vi.useFakeTimers();
      try {
        limiter = createMessageRateLimiter({
          burstLimit: 2,
          cooldownMs: 3000,
          pruneIntervalMs: 0,
        });
        const key = "webchat:default:sender6";

        limiter.record(key);
        limiter.record(key);

        // Trigger burst detection
        const burstResult = limiter.check(key);
        expect(burstResult.allowed).toBe(false);

        // Advance past both the cooldown (3 s) and the burst window (10 s)
        // so the old burst timestamps are outside the 10 s window.
        vi.advanceTimersByTime(11_000);

        const afterCooldown = limiter.check(key);
        expect(afterCooldown.allowed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("per-channel override", () => {
    it("uses channel-specific limits when configured", () => {
      limiter = createMessageRateLimiter({
        maxMessagesPerMinute: 20,
        burstLimit: 100,
        perChannel: {
          discord: { maxMessagesPerMinute: 5 },
        },
        pruneIntervalMs: 0,
      });

      const discordKey = "discord:main:user1";
      const whatsappKey = "whatsapp:default:user1";

      // Discord should throttle at 5
      for (let i = 0; i < 5; i++) {
        limiter.record(discordKey);
      }
      expect(limiter.check(discordKey).allowed).toBe(false);

      // WhatsApp should still be fine at 5 (default=20)
      for (let i = 0; i < 5; i++) {
        limiter.record(whatsappKey);
      }
      expect(limiter.check(whatsappKey).allowed).toBe(true);
    });
  });

  describe("exempt sender", () => {
    it("bypasses all limits for exempt senders", () => {
      limiter = createMessageRateLimiter({
        maxMessagesPerMinute: 3,
        burstLimit: 2,
        exemptSenders: ["admin-user"],
        pruneIntervalMs: 0,
      });

      const key = "telegram:default:admin-user";

      // Record many messages — should all pass
      for (let i = 0; i < 50; i++) {
        const result = limiter.check(key);
        expect(result.allowed).toBe(true);
        limiter.record(key);
      }
    });
  });

  describe("exempt channel", () => {
    it("bypasses all limits for exempt channels", () => {
      limiter = createMessageRateLimiter({
        maxMessagesPerMinute: 3,
        burstLimit: 2,
        exemptChannels: ["webchat"],
        pruneIntervalMs: 0,
      });

      const key = "webchat:default:any-user";

      for (let i = 0; i < 50; i++) {
        const result = limiter.check(key);
        expect(result.allowed).toBe(true);
        limiter.record(key);
      }
    });
  });

  describe("prune", () => {
    it("cleans up old entries after prune", () => {
      vi.useFakeTimers();
      try {
        limiter = createMessageRateLimiter({ pruneIntervalMs: 0 });
        const key = "whatsapp:default:old-sender";

        limiter.record(key);
        expect(limiter.size()).toBe(1);

        // Advance past the hour window so the entry is stale
        vi.advanceTimersByTime(3_600_001);
        limiter.prune();

        expect(limiter.size()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("stats", () => {
    it("returns correct counts via getStats", () => {
      limiter = createMessageRateLimiter({ pruneIntervalMs: 0 });
      const key = "telegram:default:stats-sender";

      expect(limiter.getStats(key)).toBeNull();

      limiter.record(key);
      limiter.record(key);
      limiter.record(key);

      const stats = limiter.getStats(key);
      expect(stats).not.toBeNull();
      expect(stats!.messagesLastMinute).toBe(3);
      expect(stats!.messagesLastHour).toBe(3);
      expect(stats!.burstCount).toBe(3);
      expect(stats!.lastMessageAt).toBeGreaterThan(0);
    });
  });

  describe("reset", () => {
    it("reset(key) clears a specific sender", () => {
      limiter = createMessageRateLimiter({ pruneIntervalMs: 0 });
      const key1 = "discord:default:user-a";
      const key2 = "discord:default:user-b";

      limiter.record(key1);
      limiter.record(key2);
      expect(limiter.size()).toBe(2);

      limiter.reset(key1);
      expect(limiter.size()).toBe(1);
      expect(limiter.getStats(key1)).toBeNull();
      expect(limiter.getStats(key2)).not.toBeNull();
    });

    it("resetAll clears all senders", () => {
      limiter = createMessageRateLimiter({ pruneIntervalMs: 0 });
      limiter.record("a:b:c");
      limiter.record("d:e:f");
      expect(limiter.size()).toBe(2);

      limiter.resetAll();
      expect(limiter.size()).toBe(0);
    });
  });

  describe("disabled", () => {
    it("allows everything when enabled=false", () => {
      limiter = createMessageRateLimiter({
        enabled: false,
        maxMessagesPerMinute: 1,
        burstLimit: 1,
        pruneIntervalMs: 0,
      });
      const key = "whatsapp:default:anyone";

      for (let i = 0; i < 100; i++) {
        expect(limiter.check(key).allowed).toBe(true);
        limiter.record(key);
      }
    });
  });
});
