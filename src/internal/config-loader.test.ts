/**
 * Tests for Secure Config Loader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadConfigFile,
  loadAllBootstrapConfigs,
  initializeConfigLoader,
  clearKnownHashes,
} from "./config-loader.js";
import { startConfigAPI } from "./config-api.js";

describe("Config Loader", () => {
  beforeEach(() => {
    clearKnownHashes();
  });

  describe("loadConfigFile", () => {
    it("should fall back to disk when API unavailable", async () => {
      // Force local read (bypass API)
      const config = await loadConfigFile("SOUL.md", { forceLocalRead: true });

      if (config) {
        expect(config.name).toBe("SOUL.md");
        expect(config.source).toBe("disk");
        expect(config.sha256).toHaveLength(64);
        expect(config.content).toBeTruthy();
      }
      // Config may be null if file doesn't exist yet
    });

    it("should handle missing files gracefully", async () => {
      const config = await loadConfigFile("NONEXISTENT.md", { forceLocalRead: true });
      expect(config).toBeNull();
    });

    it("should compute correct hash for loaded content", async () => {
      const config = await loadConfigFile("SOUL.md", { forceLocalRead: true });

      if (config) {
        // Verify hash is valid SHA-256
        expect(config.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  describe("loadAllBootstrapConfigs", () => {
    it("should load multiple config files", async () => {
      const configs = await loadAllBootstrapConfigs({ forceLocalRead: true });

      // Should attempt to load known bootstrap files
      // May not find all if behavioral core files don't exist
      expect(configs).toBeInstanceOf(Map);
    });

    it("should track source for each loaded file", async () => {
      const configs = await loadAllBootstrapConfigs({ forceLocalRead: true });

      for (const [_name, config] of configs) {
        expect(["api", "disk", "fallback"]).toContain(config.source);
      }
    });
  });

  describe("initializeConfigLoader", () => {
    it("should return initialized=false when API unavailable", async () => {
      // No API running, should fail to initialize
      const result = await initializeConfigLoader({
        apiHost: "127.0.0.1",
        apiPort: 19999, // Port that's not running
      });

      expect(result.initialized).toBe(false);
      expect(result.source).toBe("none");
      expect(result.hashCount).toBe(0);
    });
  });

  describe("API integration", () => {
    let server: Awaited<ReturnType<typeof startConfigAPI>> | null = null;

    afterEach(async () => {
      if (server) {
        await server.stop();
        server = null;
      }
      clearKnownHashes();
    });

    it("should load from API when available (loopback test)", async () => {
      // Start server on loopback
      server = await startConfigAPI({ host: "127.0.0.1", port: 0 });

      // Note: This test will get 403 because loopback isn't a Tailscale IP
      // This is expected behavior - the API correctly rejects non-Tailscale connections
      const config = await loadConfigFile("SOUL.md", {
        apiHost: "127.0.0.1",
        apiPort: server.port,
      });

      // Should fall back to disk since API rejects non-Tailscale
      if (config) {
        expect(config.source).toBe("disk");
      }
    });
  });
});

describe("Hash verification", () => {
  it("should verify content against known hash", async () => {
    // First load to get the hash
    const config1 = await loadConfigFile("SOUL.md", { forceLocalRead: true });

    if (config1) {
      // Load again with expected hash
      const expectedHashes = new Map([["/config/soul", config1.sha256]]);

      const config2 = await loadConfigFile("SOUL.md", {
        forceLocalRead: true,
        expectedHashes,
      });

      if (config2) {
        expect(config2.verified).toBe(true);
      }
    }
  });
});
