/**
 * Tests for safe mode configuration
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isSafeModeEnabled,
  getSafeModeOptions,
  createSafeModeConfig,
  validateSafeModeConfig,
  applySafeModeRestrictions,
  shouldStartInSafeMode,
  createSafeModeSentinel,
  removeSafeModeSentinel,
} from "./safe-mode.js";
import type { OpenClawConfig } from "./types.js";

// Mock the paths module
vi.mock("./paths.js", () => ({
  resolveStateDir: vi.fn(() => "/test/state"),
}));

vi.mock("../infra/dotenv.js", () => ({
  resolveRequiredHomeDir: vi.fn(() => "/test/home"),
}));

describe("Safe Mode", () => {
  let mockEnv: NodeJS.ProcessEnv;
  let tempDir: string;

  beforeEach(async () => {
    // Create temporary directory for tests
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-safe-mode-test-"));

    // Reset environment
    mockEnv = {};

    // Mock fs.existsSync for sentinel file
    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((path) => {
      if (typeof path === "string" && path.includes("safe-mode.sentinel")) {
        return fs.existsSync(path.replace("/test/state", tempDir));
      }
      return originalExistsSync(path);
    });
  });

  afterEach(async () => {
    // Cleanup temporary directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("isSafeModeEnabled", () => {
    it("should detect safe mode from environment variable", () => {
      expect(isSafeModeEnabled({ OPENCLAW_SAFE_MODE: "1" })).toBe(true);
      expect(isSafeModeEnabled({ OPENCLAW_SAFE_MODE: "true" })).toBe(true);
      expect(isSafeModeEnabled({ OPENCLAW_SAFE_MODE: "on" })).toBe(true);
      expect(isSafeModeEnabled({ OPENCLAW_SAFE_MODE: "false" })).toBe(false);
      expect(isSafeModeEnabled({ OPENCLAW_SAFE_MODE: "0" })).toBe(false);
      expect(isSafeModeEnabled({})).toBe(false);
    });
  });

  describe("getSafeModeOptions", () => {
    it("should parse safe mode options from environment", () => {
      const env = {
        OPENCLAW_SAFE_MODE_CHANNELS: "true",
        OPENCLAW_SAFE_MODE_AGENTS: "true",
        OPENCLAW_SAFE_MODE_PLUGINS: "false",
        OPENCLAW_SAFE_MODE_PORT: "3000",
        OPENCLAW_SAFE_MODE_PASSWORD: "secret123",
        OPENCLAW_SAFE_MODE_ALLOWED_IPS: "127.0.0.1,192.168.1.1,10.0.0.1",
      };

      const options = getSafeModeOptions(env);

      expect(options.enableChannels).toBe(true);
      expect(options.enableCustomAgents).toBe(true);
      expect(options.enablePlugins).toBe(false);
      expect(options.gatewayPort).toBe(3000);
      expect(options.adminPassword).toBe("secret123");
      expect(options.adminAllowedIps).toEqual(["127.0.0.1", "192.168.1.1", "10.0.0.1"]);
    });

    it("should handle missing environment variables", () => {
      const options = getSafeModeOptions({});

      expect(options.enableChannels).toBe(false);
      expect(options.enableCustomAgents).toBe(false);
      expect(options.enablePlugins).toBe(false);
      expect(options.gatewayPort).toBeUndefined();
      expect(options.adminPassword).toBeUndefined();
      expect(options.adminAllowedIps).toBeUndefined();
    });
  });

  describe("createSafeModeConfig", () => {
    it("should create minimal safe mode config", () => {
      const config = createSafeModeConfig();

      expect(config.gateway?.host).toBe("127.0.0.1");
      expect(config.gateway?.auth?.mode).toBe("token");
      expect(config.gateway?.auth?.token).toBeTruthy();
      expect(config.gateway?.remote?.enabled).toBe(false);
      expect(config.plugins).toEqual({ enabled: false, autoEnable: false });
      expect(config.cron).toEqual({ enabled: false });
      expect(config.browser).toEqual({ enabled: false });
      expect(config.tools?.security).toBe("allowlist");
      expect(config.ui?.safeMode).toBe(true);
    });

    it("should respect safe mode options", () => {
      const options = {
        enableChannels: true,
        enableCustomAgents: true,
        enablePlugins: true,
        enableCron: true,
        enableBrowser: true,
        gatewayPort: 9999,
        adminPassword: "custom-password",
      };

      const config = createSafeModeConfig(options);

      expect(config.gateway?.port).toBe(9999);
      expect(config.gateway?.auth?.token).toBe("custom-password");
      expect(config.channels).toBeTruthy();
      expect(config.agents?.list).toEqual([]); // Custom agents enabled but list empty
    });

    it("should include recovery agent when custom agents disabled", () => {
      const config = createSafeModeConfig({ enableCustomAgents: false });

      expect(config.agents?.list).toHaveLength(1);
      expect(config.agents?.list?.[0]?.id).toBe("recovery");
      expect(config.agents?.list?.[0]?.name).toBe("Recovery Assistant");
    });
  });

  describe("validateSafeModeConfig", () => {
    let validSafeConfig: OpenClawConfig;

    beforeEach(() => {
      validSafeConfig = createSafeModeConfig();
    });

    it("should validate proper safe mode config", () => {
      const result = validateSafeModeConfig(validSafeConfig);

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should reject config with non-localhost gateway", () => {
      const config = {
        ...validSafeConfig,
        gateway: {
          ...validSafeConfig.gateway,
          host: "0.0.0.0",
        },
      };

      const result = validateSafeModeConfig(config);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain("Safe mode gateway must bind to localhost only");
    });

    it("should require authentication", () => {
      const config = {
        ...validSafeConfig,
        gateway: {
          ...validSafeConfig.gateway,
          auth: {},
        },
      };

      const result = validateSafeModeConfig(config);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain("Safe mode requires authentication");
    });

    it("should reject external channels", () => {
      const config = {
        ...validSafeConfig,
        channels: {
          discord: { enabled: true },
          slack: { enabled: true },
        },
      };

      const result = validateSafeModeConfig(config);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain("External channel discord should be disabled in safe mode");
      expect(result.issues).toContain("External channel slack should be disabled in safe mode");
    });

    it("should require allowlist tool security", () => {
      const config = {
        ...validSafeConfig,
        tools: {
          ...validSafeConfig.tools,
          security: "denylist" as any,
        },
      };

      const result = validateSafeModeConfig(config);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain("Tool security must use allowlist mode in safe mode");
    });

    it("should reject enabled plugins", () => {
      const config = {
        ...validSafeConfig,
        plugins: { enabled: true },
      };

      const result = validateSafeModeConfig(config);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain("Plugins should be disabled in safe mode for security");
    });
  });

  describe("applySafeModeRestrictions", () => {
    let normalConfig: OpenClawConfig;

    beforeEach(() => {
      normalConfig = {
        gateway: {
          host: "0.0.0.0",
          port: 8080,
          auth: { mode: "password", password: "weak" },
          remote: { enabled: true },
          cors: { enabled: true },
        },
        channels: {
          discord: { enabled: true },
          slack: { enabled: true },
          web: { enabled: true },
        },
        plugins: { enabled: true, autoEnable: true },
        cron: { enabled: true },
        browser: { enabled: true },
        tools: { security: "denylist" as any },
        ui: { safeMode: false },
      };
    });

    it("should apply safe mode restrictions", () => {
      const restricted = applySafeModeRestrictions(normalConfig);

      expect(restricted.gateway?.host).toBe("127.0.0.1");
      expect(restricted.gateway?.auth?.mode).toBe("token");
      expect(restricted.gateway?.remote?.enabled).toBe(false);
      expect(restricted.gateway?.cors?.enabled).toBe(false);
      expect(restricted.plugins).toEqual({ enabled: false, autoEnable: false });
      expect(restricted.cron).toEqual({ enabled: false });
      expect(restricted.browser).toEqual({ enabled: false });
      expect(restricted.tools?.security).toBe("allowlist");
      expect(restricted.ui?.safeMode).toBe(true);
    });

    it("should disable external channels by default", () => {
      const restricted = applySafeModeRestrictions(normalConfig);

      expect(restricted.channels?.discord).toEqual({ enabled: false });
      expect(restricted.channels?.slack).toEqual({ enabled: false });
      // Web channel should remain untouched (local)
      expect(restricted.channels?.web).toEqual({ enabled: true });
    });

    it("should respect enableChannels option", () => {
      const restricted = applySafeModeRestrictions(normalConfig, { enableChannels: true });

      expect(restricted.channels?.discord).toEqual({ enabled: true });
      expect(restricted.channels?.slack).toEqual({ enabled: true });
    });

    it("should respect other enable options", () => {
      const restricted = applySafeModeRestrictions(normalConfig, {
        enablePlugins: true,
        enableCron: true,
        enableBrowser: true,
      });

      expect(restricted.plugins).toEqual({ enabled: true, autoEnable: true });
      expect(restricted.cron).toEqual({ enabled: true });
      expect(restricted.browser).toEqual({ enabled: true });
    });

    it("should use custom admin password", () => {
      const restricted = applySafeModeRestrictions(normalConfig, { 
        adminPassword: "custom-password"
      });

      expect(restricted.gateway?.auth?.token).toBe("custom-password");
    });
  });

  describe("sentinel file management", () => {
    let mockPaths: any;

    beforeEach(async () => {
      mockPaths = await import("./paths.js");
      vi.mocked(mockPaths.resolveStateDir).mockReturnValue(tempDir);
    });

    it("should create sentinel file", async () => {
      await createSafeModeSentinel("Test reason");

      const sentinelPath = path.join(tempDir, "safe-mode.sentinel");
      expect(fs.existsSync(sentinelPath)).toBe(true);

      const content = await fs.promises.readFile(sentinelPath, "utf-8");
      const data = JSON.parse(content);

      expect(data.reason).toBe("Test reason");
      expect(data.pid).toBe(process.pid);
      expect(data.created).toBeTruthy();
    });

    it("should remove sentinel file", async () => {
      const sentinelPath = path.join(tempDir, "safe-mode.sentinel");

      // Create sentinel file first
      await fs.promises.writeFile(sentinelPath, JSON.stringify({ test: true }));
      expect(fs.existsSync(sentinelPath)).toBe(true);

      await removeSafeModeSentinel();

      expect(fs.existsSync(sentinelPath)).toBe(false);
    });

    it("should handle missing sentinel file gracefully", async () => {
      // Should not throw when trying to remove non-existent file
      await expect(removeSafeModeSentinel()).resolves.not.toThrow();
    });
  });

  describe("shouldStartInSafeMode", () => {
    let mockPaths: any;

    beforeEach(async () => {
      mockPaths = await import("./paths.js");
      vi.mocked(mockPaths.resolveStateDir).mockReturnValue(tempDir);
    });

    it("should detect environment variable", () => {
      expect(shouldStartInSafeMode({ OPENCLAW_SAFE_MODE: "1" })).toBe(true);
    });

    it("should detect sentinel file", async () => {
      const sentinelPath = path.join(tempDir, "safe-mode.sentinel");
      await fs.promises.writeFile(sentinelPath, JSON.stringify({ created: new Date().toISOString() }));

      expect(shouldStartInSafeMode({})).toBe(true);
    });

    it("should return false when neither condition is met", () => {
      expect(shouldStartInSafeMode({})).toBe(false);
    });
  });
});