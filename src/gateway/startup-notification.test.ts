import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isStartupNotificationEnabled, sendStartupNotifications } from "./startup-notification.js";

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
  });
});
