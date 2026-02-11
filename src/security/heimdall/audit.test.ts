import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HeimdallAuditConfig } from "./types.js";
import { createHeimdallAuditLogger, getHeimdallAuditLogger, __resetAuditLogger } from "./audit.js";
import { SenderTier as SenderTierEnum } from "./types.js";

// Mock the subsystem logger module
const mockInfo = vi.fn();
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: mockInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("HeimdallAuditLogger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAuditLogger();
  });

  afterEach(() => {
    __resetAuditLogger();
  });

  const fullConfig: HeimdallAuditConfig = {
    enabled: true,
    logBlockedTools: true,
    logRedactions: true,
    logRateLimits: true,
    logSanitization: true,
  };

  describe("disabled", () => {
    it("returns noop when config undefined", () => {
      const logger = createHeimdallAuditLogger(undefined);
      logger.logToolBlocked({
        toolName: "exec",
        senderTier: SenderTierEnum.GUEST,
        reason: "denied",
      });
      expect(mockInfo).not.toHaveBeenCalled();
    });

    it("returns noop when enabled=false", () => {
      const logger = createHeimdallAuditLogger({ enabled: false });
      logger.logRedaction({ patterns: ["test"], totalMatches: 1 });
      expect(mockInfo).not.toHaveBeenCalled();
    });
  });

  describe("logToolBlocked", () => {
    it("logs blocked tool call", async () => {
      const logger = createHeimdallAuditLogger(fullConfig);
      logger.logToolBlocked({
        toolName: "exec",
        senderTier: SenderTierEnum.GUEST,
        reason: "denied by ACL",
      });
      // Wait for async emit
      await vi.waitFor(() => expect(mockInfo).toHaveBeenCalled());
      const [message, meta] = mockInfo.mock.calls[0];
      expect(message).toContain("tool_blocked");
      expect(meta.event).toBe("tool_blocked");
      expect(meta.toolName).toBe("exec");
      expect(meta.senderTier).toBe("guest");
      expect(meta.reason).toBe("denied by ACL");
    });

    it("skips when logBlockedTools=false", () => {
      const logger = createHeimdallAuditLogger({ ...fullConfig, logBlockedTools: false });
      logger.logToolBlocked({
        toolName: "exec",
        senderTier: SenderTierEnum.GUEST,
        reason: "denied",
      });
      expect(mockInfo).not.toHaveBeenCalled();
    });
  });

  describe("logRedaction", () => {
    it("logs redaction event with pattern names and count", async () => {
      const logger = createHeimdallAuditLogger(fullConfig);
      logger.logRedaction({ patterns: ["OpenAI API Key", "GitHub PAT"], totalMatches: 3 });
      await vi.waitFor(() => expect(mockInfo).toHaveBeenCalled());
      const [, meta] = mockInfo.mock.calls[0];
      expect(meta.event).toBe("redaction");
      expect(meta.patterns).toEqual(["OpenAI API Key", "GitHub PAT"]);
      expect(meta.totalMatches).toBe(3);
    });

    it("skips when logRedactions=false", () => {
      const logger = createHeimdallAuditLogger({ ...fullConfig, logRedactions: false });
      logger.logRedaction({ patterns: ["test"], totalMatches: 1 });
      expect(mockInfo).not.toHaveBeenCalled();
    });
  });

  describe("logRateLimit", () => {
    it("logs rate limit hit", async () => {
      const logger = createHeimdallAuditLogger(fullConfig);
      logger.logRateLimit({
        senderId: 12345,
        senderTier: SenderTierEnum.GUEST,
      });
      await vi.waitFor(() => expect(mockInfo).toHaveBeenCalled());
      const [, meta] = mockInfo.mock.calls[0];
      expect(meta.event).toBe("rate_limit");
      expect(meta.senderId).toBe(12345);
      expect(meta.senderTier).toBe("guest");
    });

    it("skips when logRateLimits=false", () => {
      const logger = createHeimdallAuditLogger({ ...fullConfig, logRateLimits: false });
      logger.logRateLimit({ senderId: 123, senderTier: SenderTierEnum.MEMBER });
      expect(mockInfo).not.toHaveBeenCalled();
    });
  });

  describe("logSanitization", () => {
    it("logs sanitization warnings", async () => {
      const logger = createHeimdallAuditLogger(fullConfig);
      logger.logSanitization({
        warnings: [
          { type: "truncated", detail: "Input truncated from 200000 to 100000 chars" },
          { type: "control_chars_stripped", detail: "Stripped 5 control chars" },
        ],
      });
      await vi.waitFor(() => expect(mockInfo).toHaveBeenCalled());
      const [, meta] = mockInfo.mock.calls[0];
      expect(meta.event).toBe("sanitization");
      expect(meta.warnings).toHaveLength(2);
    });

    it("skips when logSanitization=false", () => {
      const logger = createHeimdallAuditLogger({ ...fullConfig, logSanitization: false });
      logger.logSanitization({
        warnings: [{ type: "truncated", detail: "test" }],
      });
      expect(mockInfo).not.toHaveBeenCalled();
    });
  });

  describe("singleton", () => {
    it("returns same instance for same config", () => {
      const a = getHeimdallAuditLogger(fullConfig);
      const b = getHeimdallAuditLogger(fullConfig);
      expect(a).toBe(b);
    });

    it("returns new instance when config changes", () => {
      const a = getHeimdallAuditLogger(fullConfig);
      const b = getHeimdallAuditLogger({ ...fullConfig, logRedactions: false });
      expect(a).not.toBe(b);
    });
  });
});
