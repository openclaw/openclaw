import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HeimdallConfig } from "./types.js";
import { applyOutputFilter } from "./apply-filter.js";
import { __resetAuditLogger, createHeimdallAuditLogger } from "./audit.js";
import { redactOutput } from "./output-filter.js";
import { DEPLOYMENT_PATTERNS } from "./patterns.js";
import { HeimdallRateLimiter, __resetRateLimiter } from "./rate-limit.js";
import { resolveHeimdallConfig } from "./resolve-config.js";
import { sanitizeInput } from "./sanitize.js";
import { resolveSenderTier } from "./sender-tier.js";
import { wrapBlockReplyWithFilter } from "./streaming-filter.js";
import { isToolAllowed } from "./tool-acl.js";
import { SenderTier } from "./types.js";

// Mock subsystem logger for audit tests
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("Heimdall Full Pipeline Integration", () => {
  const baseConfig: HeimdallConfig = {
    enabled: true,
    senderTiers: {
      owners: [111, "thebtf"],
      members: [222, "alice"],
    },
    defaultGuestPolicy: "deny",
    toolACL: [{ pattern: "search", allowedTiers: ["member", "guest"] }],
    outputFilter: {
      enabled: true,
      customPatterns: [{ name: "TestSecret", regex: "TEST_SECRET_[A-Z0-9]{10,}", flags: "g" }],
    },
    sanitize: {
      maxLength: 50_000,
      nfkcNormalize: true,
      controlCharDensityThreshold: 0.1,
    },
    rateLimit: {
      enabled: true,
      windowMs: 60_000,
      maxMessages: 30,
      guestMaxMessages: 5,
    },
    audit: {
      enabled: true,
      logBlockedTools: true,
      logRedactions: true,
      logRateLimits: true,
      logSanitization: true,
    },
  };

  beforeEach(() => {
    __resetRateLimiter();
    __resetAuditLogger();
  });

  afterEach(() => {
    __resetRateLimiter();
    __resetAuditLogger();
  });

  describe("GATE → SANITIZE → AUTHORIZE → FILTER pipeline", () => {
    it("OWNER with clean input → all stages pass", () => {
      // GATE
      const tier = resolveSenderTier(111, undefined, baseConfig);
      expect(tier).toBe(SenderTier.OWNER);

      // SANITIZE
      const { text: sanitized, warnings } = sanitizeInput("Hello world", baseConfig.sanitize);
      expect(sanitized).toBe("Hello world");
      expect(warnings).toHaveLength(0);

      // AUTHORIZE
      expect(isToolAllowed("exec", tier, baseConfig)).toBe(true);
      expect(isToolAllowed("write", tier, baseConfig)).toBe(true);

      // FILTER
      const { redacted, matches } = redactOutput("Reply: no secrets here", baseConfig.outputFilter);
      expect(matches).toHaveLength(0);
      expect(redacted).toBe("Reply: no secrets here");
    });

    it("GUEST → exec blocked, search allowed, output filtered", () => {
      // GATE
      const tier = resolveSenderTier(999, undefined, baseConfig);
      expect(tier).toBe(SenderTier.GUEST);

      // AUTHORIZE
      expect(isToolAllowed("exec", tier, baseConfig)).toBe(false);
      expect(isToolAllowed("search", tier, baseConfig)).toBe(true);

      // FILTER
      const { redacted } = redactOutput(
        "Your key: sk-testkey1234567890abcdef",
        baseConfig.outputFilter,
      );
      expect(redacted).toContain("[REDACTED:OpenAI API Key]");
    });

    it("MEMBER → exec blocked, read allowed", () => {
      const tier = resolveSenderTier(222, undefined, baseConfig);
      expect(tier).toBe(SenderTier.MEMBER);

      expect(isToolAllowed("exec", tier, baseConfig)).toBe(false);
      expect(isToolAllowed("read", tier, baseConfig)).toBe(true);
      expect(isToolAllowed("search", tier, baseConfig)).toBe(true);
    });
  });

  describe("config cascade: global + per-channel merge", () => {
    it("per-channel toolACL replaces global", () => {
      const channelCfg: HeimdallConfig = {
        toolACL: [{ pattern: "exec", allowedTiers: ["member"] }],
      };
      const merged = resolveHeimdallConfig(baseConfig, channelCfg)!;
      const tier = resolveSenderTier(222, undefined, merged);
      expect(tier).toBe(SenderTier.MEMBER);
      // Channel gives member exec access
      expect(isToolAllowed("exec", tier, merged)).toBe(true);
    });

    it("per-channel owners UNION with global", () => {
      const channelCfg: HeimdallConfig = {
        senderTiers: { owners: [333] },
      };
      const merged = resolveHeimdallConfig(baseConfig, channelCfg)!;
      const tier333 = resolveSenderTier(333, undefined, merged);
      expect(tier333).toBe(SenderTier.OWNER);
      // Original owner still works
      const tier111 = resolveSenderTier(111, undefined, merged);
      expect(tier111).toBe(SenderTier.OWNER);
    });
  });

  describe("feature flag off → entire pipeline no-op", () => {
    it("disabled heimdall passes everything through", () => {
      const disabledConfig: HeimdallConfig = { enabled: false };
      // sanitize still works standalone
      const { text } = sanitizeInput("test", {});
      expect(text).toBe("test");
      // filter passthrough
      const payloads = [{ text: "sk-secret123456789012345" }];
      const filtered = applyOutputFilter(payloads, disabledConfig);
      expect(filtered[0].text).toBe("sk-secret123456789012345");
    });
  });

  describe("rate-limited GUEST → blocked before LLM", () => {
    it("GUEST exceeds rate limit after guestMaxMessages", () => {
      const limiter = new HeimdallRateLimiter(baseConfig.rateLimit!);
      const tier = resolveSenderTier(999, undefined, baseConfig);
      expect(tier).toBe(SenderTier.GUEST);

      for (let i = 0; i < 5; i++) {
        expect(limiter.check("999", tier).allowed).toBe(true);
      }
      expect(limiter.check("999", tier).allowed).toBe(false);
      limiter.destroy();
    });

    it("OWNER is never rate-limited", () => {
      const limiter = new HeimdallRateLimiter(baseConfig.rateLimit!);
      for (let i = 0; i < 100; i++) {
        expect(limiter.check("111", SenderTier.OWNER).allowed).toBe(true);
      }
      limiter.destroy();
    });
  });

  describe("streaming + batch filter both applied", () => {
    it("batch filter redacts API keys", () => {
      const payloads = [{ text: "Key: sk-abc123defghijklmnopqrst" }, { text: "Clean" }];
      const filtered = applyOutputFilter(payloads, baseConfig);
      expect(filtered[0].text).toContain("[REDACTED:OpenAI API Key]");
      expect(filtered[1].text).toBe("Clean");
    });

    it("streaming filter redacts in callback", async () => {
      const received: Array<{ text?: string }> = [];
      const original = async (p: { text?: string }) => {
        received.push(p);
      };
      const wrapped = wrapBlockReplyWithFilter(original, baseConfig);
      await wrapped({ text: "Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
      expect(received[0].text).toContain("[REDACTED:GitHub PAT]");
    });
  });

  describe("custom patterns from config", () => {
    it("TEST_SECRET custom pattern matched", () => {
      const { redacted } = redactOutput(
        "Deployment: TEST_SECRET_ABCDEFGHIJ",
        baseConfig.outputFilter,
      );
      expect(redacted).toContain("[REDACTED:TestSecret]");
    });
  });

  describe("deployment patterns", () => {
    it("all deployment patterns compile successfully", () => {
      for (const p of DEPLOYMENT_PATTERNS) {
        expect(() => new RegExp(p.regex, p.flags ?? "g")).not.toThrow();
      }
    });
  });

  describe("multi-agent: senderTier preserved in followup run", () => {
    it("same config resolves same tier (deterministic)", () => {
      const tier1 = resolveSenderTier(222, "alice", baseConfig);
      const tier2 = resolveSenderTier(222, "alice", baseConfig);
      expect(tier1).toBe(SenderTier.MEMBER);
      expect(tier1).toBe(tier2);
    });

    it("username resolution works case-insensitively", () => {
      const tier1 = resolveSenderTier("unknown", "TheBtf", baseConfig);
      expect(tier1).toBe(SenderTier.OWNER);
      const tier2 = resolveSenderTier("unknown", "ALICE", baseConfig);
      expect(tier2).toBe(SenderTier.MEMBER);
    });
  });

  describe("audit events emitted for each stage", () => {
    it("audit logger created successfully", () => {
      const logger = createHeimdallAuditLogger(baseConfig.audit);
      expect(logger).toBeDefined();
      expect(typeof logger.logToolBlocked).toBe("function");
      expect(typeof logger.logRedaction).toBe("function");
      expect(typeof logger.logRateLimit).toBe("function");
      expect(typeof logger.logSanitization).toBe("function");
    });
  });
});
