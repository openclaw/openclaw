import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearInternalHooks,
  triggerInternalHook,
  createInternalHookEvent,
} from "../hooks/internal-hooks.js";

// Mock oag-event-bus
const mockEmitOagEvent = vi.fn();
vi.mock("./oag-event-bus.js", () => ({
  emitOagEvent: (...args: unknown[]) => mockEmitOagEvent(...args),
}));

// Mock logging
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("oag-delivery-watchdog", () => {
  beforeEach(async () => {
    clearInternalHooks();
    mockEmitOagEvent.mockClear();
    // Reset watchdog state between tests
    const { resetDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");
    resetDeliveryWatchdog();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  describe("basic functionality", () => {
    it("emits anomaly_detected on message too long error", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "Bad Request: message is too long",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          type: "delivery_failure",
          subtype: "message_too_long",
          channel: "telegram",
          error: "Bad Request: message is too long",
        }),
      );
    });

    it("does not emit on successful delivery", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: true,
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).not.toHaveBeenCalled();
    });

    it("ignores recoverable errors like timeout", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "timeout: request timed out",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).not.toHaveBeenCalled();
    });

    it("ignores rate limit errors", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "rate limit exceeded",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).not.toHaveBeenCalled();
    });

    it("can be disabled via config", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog({ enabled: false });

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "Bad Request: message is too long",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).not.toHaveBeenCalled();
    });

    it("cleanup function stops the watchdog", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      const cleanup = startDeliveryWatchdog();

      // Trigger once to verify it's working
      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "Bad Request: message is too long",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledTimes(1);

      // Cleanup
      cleanup();

      // Trigger again - should not emit
      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "Bad Request: message is too long",
          channelId: "telegram",
        }),
      );

      // Still 1, not 2
      expect(mockEmitOagEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("duplicate registration prevention", () => {
    it("does not register duplicate handler on second start", async () => {
      const { startDeliveryWatchdog, isDeliveryWatchdogRunning } =
        await import("./oag-delivery-watchdog.js");

      const cleanup1 = startDeliveryWatchdog();
      expect(isDeliveryWatchdogRunning()).toBe(true);

      // Second start should not register a new handler
      const cleanup2 = startDeliveryWatchdog();
      expect(isDeliveryWatchdogRunning()).toBe(true);

      // Trigger once
      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "Bad Request: message is too long",
          channelId: "telegram",
        }),
      );

      // Should only emit once (not twice from duplicate handler)
      expect(mockEmitOagEvent).toHaveBeenCalledTimes(1);

      cleanup1();
      cleanup2();
    });

    it("isDeliveryWatchdogRunning returns correct state", async () => {
      const { startDeliveryWatchdog, isDeliveryWatchdogRunning, resetDeliveryWatchdog } =
        await import("./oag-delivery-watchdog.js");

      resetDeliveryWatchdog();
      expect(isDeliveryWatchdogRunning()).toBe(false);

      const cleanup = startDeliveryWatchdog();
      expect(isDeliveryWatchdogRunning()).toBe(true);

      cleanup();
      expect(isDeliveryWatchdogRunning()).toBe(false);
    });
  });

  describe("channel text limits", () => {
    it("returns default channel text limits", async () => {
      const { getDefaultChannelTextLimits } = await import("./oag-delivery-watchdog.js");

      const limits = getDefaultChannelTextLimits();

      expect(limits.telegram).toBe(4096);
      expect(limits.discord).toBe(2000);
      expect(limits.slack).toBe(4000);
      expect(limits.irc).toBe(350);
      expect(limits.line).toBe(5000);
      expect(limits.googlechat).toBe(4000);
      expect(limits.msteams).toBe(4000);
    });

    it("supports custom channel text limits", async () => {
      const { startDeliveryWatchdog, getChannelTextLimits } =
        await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog({
        channelTextLimits: {
          telegram: 3000,
          custom_channel: 1000,
        },
      });

      const limits = getChannelTextLimits();

      expect(limits.telegram).toBe(3000);
      expect(limits.custom_channel).toBe(1000);
      // Default discord limit preserved
      expect(limits.discord).toBe(2000);
    });
  });

  describe("error patterns", () => {
    it("detects chat not found error", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user456",
          content: "hello",
          success: false,
          error: "Bad Request: chat not found",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          type: "delivery_failure",
          channel: "telegram",
          error: "Bad Request: chat not found",
        }),
      );
    });

    it("detects bot was blocked error", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user789",
          content: "notification",
          success: false,
          error: "Forbidden: bot was blocked by the user",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          type: "delivery_failure",
          channel: "telegram",
          error: "Forbidden: bot was blocked by the user",
        }),
      );
    });

    it("does not match generic forbidden string", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "access forbidden for this resource",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).not.toHaveBeenCalled();
    });

    it("supports additional error patterns", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog({
        additionalErrorPatterns: [/custom error pattern/i],
      });

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "custom error pattern occurred",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          type: "delivery_failure",
          error: "custom error pattern occurred",
        }),
      );
    });

    it("ignores invalid regex patterns gracefully", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      // Should not throw on invalid regex
      expect(() =>
        startDeliveryWatchdog({
          additionalErrorPatterns: ["[invalid(regex"],
        }),
      ).not.toThrow();
    });
  });

  describe("config resolution", () => {
    it("resolves config from OpenClawConfig", async () => {
      const { resolveDeliveryWatchdogConfig } = await import("./oag-delivery-watchdog.js");

      const cfg = {
        gateway: {
          oag: {
            watchdog: {
              enabled: false,
              channelTextLimits: {
                telegram: 3000,
              },
              additionalErrorPatterns: ["my custom pattern"],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const config = resolveDeliveryWatchdogConfig(cfg);

      expect(config.enabled).toBe(false);
      expect(config.channelTextLimits.telegram).toBe(3000);
      expect(config.additionalErrorPatterns).toHaveLength(1);
      expect(config.additionalErrorPatterns[0].source).toBe("my custom pattern");
    });

    it("uses defaults when no config provided", async () => {
      const { resolveDeliveryWatchdogConfig } = await import("./oag-delivery-watchdog.js");

      const config = resolveDeliveryWatchdogConfig(undefined);

      expect(config.enabled).toBe(true);
      expect(config.channelTextLimits.telegram).toBe(4096);
      expect(config.additionalErrorPatterns).toHaveLength(0);
    });
  });

  describe("suggestions", () => {
    it("includes truncate suggestion for message too long", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "a".repeat(5000),
          success: false,
          error: "Bad Request: message is too long",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          subtype: "message_too_long",
          suggestion: {
            action: "truncate_or_split",
            channelLimit: 4096,
          },
        }),
      );
    });

    it("uses configured limit for suggestion", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog({
        channelTextLimits: {
          telegram: 3000,
        },
      });

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "Bad Request: message is too long",
          channelId: "telegram",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          suggestion: {
            action: "truncate_or_split",
            channelLimit: 3000,
          },
        }),
      );
    });
  });

  describe("context extraction", () => {
    it("includes additional context in anomaly event", async () => {
      const { startDeliveryWatchdog } = await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "test-session", {
          to: "user123",
          content: "test",
          success: false,
          error: "Bad Request: chat not found",
          channelId: "telegram",
          accountId: "account-456",
          conversationId: "conv-789",
          messageId: "msg-001",
          isGroup: true,
          groupId: "group-123",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          accountId: "account-456",
          conversationId: "conv-789",
          messageId: "msg-001",
          groupId: "group-123",
          isGroup: true,
        }),
      );
    });
  });

  describe("deep merge config", () => {
    it("deep merges channelTextLimits on update", async () => {
      const { startDeliveryWatchdog, updateDeliveryWatchdogConfig, getChannelTextLimits } =
        await import("./oag-delivery-watchdog.js");

      startDeliveryWatchdog({
        channelTextLimits: {
          telegram: 3000,
          discord: 1800,
        },
      });

      // Update should merge, not replace
      updateDeliveryWatchdogConfig({
        channelTextLimits: {
          telegram: 2500,
          slack: 3500,
        },
      });

      const limits = getChannelTextLimits();

      expect(limits.telegram).toBe(2500); // Updated
      expect(limits.discord).toBe(1800); // Preserved
      expect(limits.slack).toBe(3500); // Added
    });
  });
});
