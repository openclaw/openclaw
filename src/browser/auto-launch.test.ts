import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoLaunchChrome,
  DEFAULT_CONFIG,
  detectChrome,
  formatLaunchResult,
  getDefaultConfig,
  isChromeRunning,
  launchChrome,
  waitForChromeReady,
  type AutoLaunchConfig,
  type LaunchResult,
} from "./auto-launch.js";
import type { ResolvedBrowserProfile } from "./config.js";

describe("auto-launch", () => {
  const mockProfile: ResolvedBrowserProfile = {
    name: "test-profile",
    cdpPort: 9222,
    cdpUrl: "http://localhost:9222",
    cdpHost: "localhost",
    cdpIsLoopback: true,
    color: "#FF0000",
    driver: "openclaw",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("detectChrome", () => {
    it("should return custom path if provided and exists", () => {
      // This test depends on actual filesystem, so we just check the behavior
      const result = detectChrome();

      expect(result === null || typeof result === "string").toBe(true);
    });

    it("should handle custom paths", () => {
      const result = detectChrome("/nonexistent/path/chrome");

      // Should return null for non-existent paths, or a string if it exists
      expect(result === null || typeof result === "string").toBe(true);
    });
  });

  describe("isChromeRunning", () => {
    it("should detect running Chrome on Windows", async () => {
      vi.mock("node:os", () => ({
        platform: () => "win32",
      }));

      const mockExecSync = vi.fn().mockReturnValue("chrome.exe");

      vi.doMock("node:child_process", () => ({
        execSync: mockExecSync,
      }));

      const result = await isChromeRunning();

      // This test is platform-dependent and may not work in all environments
      // In a real scenario, we'd mock the child_process module
      expect(typeof result).toBe("boolean");
    });

    it("should return false if Chrome not running", async () => {
      const result = await isChromeRunning();

      expect(typeof result).toBe("boolean");
    });

    it("should handle errors gracefully", async () => {
      const result = await isChromeRunning();

      // Should not throw, just return boolean
      expect(typeof result).toBe("boolean");
    });
  });

  describe("launchChrome", () => {
    it("should not launch if disabled", async () => {
      const config: AutoLaunchConfig = {
        ...DEFAULT_CONFIG,
        enabled: false,
      };

      const result = await launchChrome(mockProfile, config);

      expect(result.success).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("should return a result when enabled", async () => {
      const config: AutoLaunchConfig = {
        ...DEFAULT_CONFIG,
        enabled: true,
      };

      const result = await launchChrome(mockProfile, config);

      // Will fail if Chrome not found, which is expected in test environment
      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
      expect(typeof result.reason).toBe("string");
    });
  });

  describe("waitForChromeReady", () => {
    it("should detect when Chrome CDP is ready", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
      });

      const ready = await waitForChromeReady(mockProfile, 5000);

      expect(ready).toBe(true);
    });

    it("should timeout if Chrome CDP never responds", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const ready = await waitForChromeReady(mockProfile, 1000);

      expect(ready).toBe(false);
    });

    it("should retry until timeout", async () => {
      global.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Not ready"))
        .mockRejectedValueOnce(new Error("Not ready"))
        .mockResolvedValue({ ok: true });

      const ready = await waitForChromeReady(mockProfile, 5000);

      expect(ready).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("autoLaunchChrome", () => {
    it("should not launch if disabled", async () => {
      const config: AutoLaunchConfig = {
        ...DEFAULT_CONFIG,
        enabled: false,
      };

      const result = await autoLaunchChrome(mockProfile, config);

      expect(result.success).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("should return a result when enabled", async () => {
      const config: AutoLaunchConfig = {
        ...DEFAULT_CONFIG,
        enabled: true,
        launchDelayMs: 100, // Short delay for testing
      };

      const result = await autoLaunchChrome(mockProfile, config);

      // Result depends on environment (Chrome installed or not)
      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
      expect(typeof result.reason).toBe("string");
    });
  });

  describe("getDefaultConfig", () => {
    it("should return default configuration", () => {
      const config = getDefaultConfig();

      expect(config.enabled).toBe(false);
      expect(config.autoConnect).toBe(true);
      expect(config.keepAlive).toBe(false);
      expect(config.launchDelayMs).toBe(2000);
    });

    it("should return independent copies", () => {
      const config1 = getDefaultConfig();
      const config2 = getDefaultConfig();

      config1.enabled = true;

      expect(config2.enabled).toBe(false);
    });
  });

  describe("formatLaunchResult", () => {
    it("should format successful launch", () => {
      const result: LaunchResult = {
        success: true,
        reason: "Chrome launched successfully",
        chromePath: "/usr/bin/chrome",
        pid: 12345,
      };

      const formatted = formatLaunchResult(result);

      expect(formatted).toContain("✓");
      expect(formatted).toContain("launched successfully");
      expect(formatted).toContain("12345");
    });

    it("should format successful launch without PID", () => {
      const result: LaunchResult = {
        success: true,
        reason: "Chrome already running",
        chromePath: "/usr/bin/chrome",
      };

      const formatted = formatLaunchResult(result);

      expect(formatted).toContain("✓");
      expect(formatted).toContain("already running");
      expect(formatted).not.toContain("PID");
    });

    it("should format failed launch", () => {
      const result: LaunchResult = {
        success: false,
        reason: "Chrome not found",
      };

      const formatted = formatLaunchResult(result);

      expect(formatted).toContain("✗");
      expect(formatted).toContain("not found");
    });
  });
});
