import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// Mock dependencies
vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: vi.fn(),
}));

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: vi.fn(),
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn(),
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn(() => ({})),
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: vi.fn(() => "test-session"),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Import mocked modules
import { normalizeChannelId } from "../channels/plugins/index.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
// Import functions under test
import {
  isStartupNotificationEnabled,
  sendNotificationToTarget,
  sendStartupNotifications,
} from "./startup-notification.js";

const createMockConfig = (startupNotification?: unknown): OpenClawConfig =>
  ({
    gateway: {
      startupNotification: startupNotification as never,
    },
  }) as OpenClawConfig;

describe("startup-notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isStartupNotificationEnabled", () => {
    it("returns false when config is undefined", () => {
      expect(isStartupNotificationEnabled(undefined)).toBe(false);
    });

    it("returns false when enabled is not true", () => {
      expect(isStartupNotificationEnabled({ enabled: false })).toBe(false);
      expect(isStartupNotificationEnabled({ enabled: undefined })).toBe(false);
      expect(isStartupNotificationEnabled({})).toBe(false);
    });

    it("returns false when targets is empty", () => {
      expect(isStartupNotificationEnabled({ enabled: true, targets: [] })).toBe(false);
    });

    it("returns true when enabled and has targets", () => {
      expect(
        isStartupNotificationEnabled({
          enabled: true,
          targets: [{ channel: "telegram", to: "123456" }],
        }),
      ).toBe(true);
    });
  });

  describe("sendStartupNotifications", () => {
    it("returns zero counts when disabled", async () => {
      const cfg = createMockConfig({ enabled: false, targets: [] });
      const result = await sendStartupNotifications({ cfg });
      expect(result).toEqual({ sent: 0, failed: 0 });
    });

    it("returns zero counts when no config", async () => {
      const cfg = createMockConfig(undefined);
      const result = await sendStartupNotifications({
        cfg,
        config: undefined,
      });
      expect(result).toEqual({ sent: 0, failed: 0 });
    });

    it("returns zero counts when enabled but no targets", async () => {
      const cfg = createMockConfig({ enabled: true, targets: [] });
      const result = await sendStartupNotifications({ cfg });
      expect(result).toEqual({ sent: 0, failed: 0 });
    });
  });

  describe("sendNotificationToTarget", () => {
    it("successfully sends notification to valid target -> returns true", async () => {
      vi.mocked(normalizeChannelId).mockReturnValue("telegram");
      vi.mocked(resolveOutboundTarget).mockReturnValue({ ok: true, to: "123456" } as never);
      vi.mocked(resolveMainSessionKey).mockReturnValue("test-session");
      vi.mocked(buildOutboundSessionContext).mockReturnValue({} as never);
      vi.mocked(deliverOutboundPayloads).mockResolvedValue([]);

      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "telegram", to: "123456" },
        message: "Test message",
      });

      expect(result).toBe(true);
    });

    it("sends correct payload to deliverOutboundPayloads", async () => {
      vi.mocked(normalizeChannelId).mockReturnValue("telegram");
      vi.mocked(resolveOutboundTarget).mockReturnValue({ ok: true, to: "123456" } as never);
      vi.mocked(deliverOutboundPayloads).mockResolvedValue([]);

      const cfg = createMockConfig({});
      await sendNotificationToTarget({
        cfg,
        target: { channel: "telegram", to: "123456" },
        message: "Test message",
      });

      expect(deliverOutboundPayloads).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads: [{ text: "Test message" }],
        }),
      );
    });

    it("handles invalid/unknown channel -> returns false", async () => {
      vi.mocked(normalizeChannelId).mockReturnValue(null);

      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "unknown", to: "123456" },
        message: "Test message",
      });

      expect(result).toBe(false);
    });

    it("handles target resolution failure -> returns false", async () => {
      vi.mocked(normalizeChannelId).mockReturnValue("telegram");
      vi.mocked(resolveOutboundTarget).mockReturnValue({ ok: false, error: "not found" } as never);

      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "telegram", to: "invalid" },
        message: "Test message",
      });

      expect(result).toBe(false);
    });

    it("handles delivery failure/throw -> returns false", async () => {
      vi.mocked(normalizeChannelId).mockReturnValue("telegram");
      vi.mocked(resolveOutboundTarget).mockReturnValue({ ok: true, to: "123456" } as never);
      vi.mocked(deliverOutboundPayloads).mockRejectedValue(new Error("delivery failed"));

      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "telegram", to: "123456" },
        message: "Test message",
      });

      expect(result).toBe(false);
    });

    it("handles empty target fields -> returns false", async () => {
      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "", to: "" },
        message: "Test message",
      });

      expect(result).toBe(false);
    });

    it("uses provided message in payload", async () => {
      vi.mocked(normalizeChannelId).mockReturnValue("telegram");
      vi.mocked(resolveOutboundTarget).mockReturnValue({ ok: true, to: "123456" } as never);
      vi.mocked(deliverOutboundPayloads).mockResolvedValue([]);

      const customMessage = "Custom notification message";
      const cfg = createMockConfig({});
      await sendNotificationToTarget({
        cfg,
        target: { channel: "telegram", to: "123456" },
        message: customMessage,
      });

      expect(deliverOutboundPayloads).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads: [{ text: customMessage }],
        }),
      );
    });
  });
});
