import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as channels from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import * as sessions from "../config/sessions.js";
import * as deliver from "../infra/outbound/deliver.js";
import * as sessionContext from "../infra/outbound/session-context.js";
import * as targets from "../infra/outbound/targets.js";
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
    it("successfully sends notification to valid target", async () => {
      vi.spyOn(channels, "normalizeChannelId").mockReturnValue("telegram");
      vi.spyOn(targets, "resolveOutboundTarget").mockReturnValue({
        ok: true,
        to: "123456",
      } as never);
      vi.spyOn(sessions, "resolveMainSessionKey").mockReturnValue("test-session");
      vi.spyOn(sessionContext, "buildOutboundSessionContext").mockReturnValue({} as never);
      vi.spyOn(deliver, "deliverOutboundPayloads").mockResolvedValue(undefined);

      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "telegram", to: "123456" },
        message: "Test message",
      });

      expect(result).toBe(true);
      expect(deliver.deliverOutboundPayloads).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads: [{ text: "Test message" }],
        }),
      );
    });

    it("handles invalid/unknown channel", async () => {
      vi.spyOn(channels, "normalizeChannelId").mockReturnValue(null);

      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "unknown", to: "123456" },
        message: "Test message",
      });

      expect(result).toBe(false);
    });

    it("handles target resolution failure", async () => {
      vi.spyOn(channels, "normalizeChannelId").mockReturnValue("telegram");
      vi.spyOn(targets, "resolveOutboundTarget").mockReturnValue({
        ok: false,
        error: "not found",
      } as never);

      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "telegram", to: "invalid" },
        message: "Test message",
      });

      expect(result).toBe(false);
    });

    it("handles delivery failure/throw", async () => {
      vi.spyOn(channels, "normalizeChannelId").mockReturnValue("telegram");
      vi.spyOn(targets, "resolveOutboundTarget").mockReturnValue({
        ok: true,
        to: "123456",
      } as never);
      vi.spyOn(sessions, "resolveMainSessionKey").mockReturnValue("test-session");
      vi.spyOn(sessionContext, "buildOutboundSessionContext").mockReturnValue({} as never);
      vi.spyOn(deliver, "deliverOutboundPayloads").mockRejectedValue(new Error("delivery failed"));

      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "telegram", to: "123456" },
        message: "Test message",
      });

      expect(result).toBe(false);
    });

    it("handles empty target fields", async () => {
      const cfg = createMockConfig({});
      const result = await sendNotificationToTarget({
        cfg,
        target: { channel: "", to: "" },
        message: "Test message",
      });

      expect(result).toBe(false);
    });
  });
});
