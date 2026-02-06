/**
 * Configuration Loader Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConfigLoader } from "../config-loader.js";
import { ExtractionErrorCode } from "../types.js";

describe("ConfigLoader", () => {
  beforeEach(() => {
    // Clear cache before each test
    ConfigLoader.clearCache();
  });

  describe("load", () => {
    it("should load claude-code configuration", () => {
      const config = ConfigLoader.load("claude-code");

      expect(config.name).toBe("claude-code");
      expect(config.schema_version).toBe(1);
      expect(config.response_marker).toBe("⏺");
      expect(config.prompt_marker).toBe(">");
      expect(config.echo_pattern).toBe("^HEALTH_\\d+$");
      expect(config.indentation).toBe(2);
      expect(config.stop_patterns).toBeInstanceOf(Array);
      expect(config.noise_patterns).toBeInstanceOf(Array);
    });

    it("should load codex configuration", () => {
      const config = ConfigLoader.load("codex");

      expect(config.name).toBe("codex");
      expect(config.schema_version).toBe(1);
      expect(config.response_marker).toBe("•");
      expect(config.prompt_marker).toBe("›");
      expect(config.special_handling?.command_blocks).toBeDefined();
      expect(config.special_handling?.command_blocks?.enabled).toBe(true);
    });

    it("should load default configuration", () => {
      const config = ConfigLoader.load("default");

      expect(config.name).toBe("default");
      expect(config.schema_version).toBe(1);
      expect(config.response_marker).toBeDefined();
      expect(config.prompt_marker).toBeDefined();
    });

    it("should fall back to default for unknown LLM types", () => {
      const config = ConfigLoader.load("unknown-llm");

      expect(config.name).toBe("default");
    });

    it("should cache loaded configurations", () => {
      const config1 = ConfigLoader.load("claude-code");
      const config2 = ConfigLoader.load("claude-code");

      // Should return same instance
      expect(config1).toBe(config2);
    });

    it("should validate required fields", () => {
      // This would require a mock config file or mock fs
      // For now, we trust that valid configs in the repo pass validation
      const config = ConfigLoader.load("claude-code");

      expect(config.response_marker).toBeTruthy();
      expect(config.prompt_marker).toBeTruthy();
      expect(Array.isArray(config.stop_patterns)).toBe(true);
      expect(Array.isArray(config.noise_patterns)).toBe(true);
    });
  });

  describe("loadAll", () => {
    it("should load all available configurations", () => {
      const configs = ConfigLoader.loadAll();

      expect(configs.size).toBeGreaterThanOrEqual(3);
      expect(configs.has("claude-code")).toBe(true);
      expect(configs.has("codex")).toBe(true);
      expect(configs.has("default")).toBe(true);
    });

    it("should return valid configurations for all types", () => {
      const configs = ConfigLoader.loadAll();

      for (const [type, config] of configs) {
        expect(config.name).toBeTruthy();
        expect(config.response_marker).toBeTruthy();
        expect(config.prompt_marker).toBeTruthy();
        expect(Array.isArray(config.stop_patterns)).toBe(true);
        expect(Array.isArray(config.noise_patterns)).toBe(true);
      }
    });
  });

  describe("clearCache", () => {
    it("should clear the configuration cache", () => {
      const config1 = ConfigLoader.load("claude-code");
      ConfigLoader.clearCache();
      const config2 = ConfigLoader.load("claude-code");

      // Should be different instances after cache clear
      expect(config1).not.toBe(config2);
      // But same content
      expect(config1.name).toBe(config2.name);
    });
  });

  describe("pattern validation", () => {
    it("should validate prefix patterns", () => {
      const config = ConfigLoader.load("claude-code");
      const prefixPattern = config.noise_patterns.find((p) => p.type === "prefix");

      expect(prefixPattern).toBeDefined();
      expect(prefixPattern?.value).toBeTruthy();
    });

    it("should validate regex patterns", () => {
      const config = ConfigLoader.load("claude-code");
      const regexPattern = config.noise_patterns.find((p) => p.type === "regex");

      expect(regexPattern).toBeDefined();
      expect(regexPattern?.pattern).toBeTruthy();

      // Should be valid regex
      if (regexPattern?.pattern) {
        expect(() => new RegExp(regexPattern.pattern)).not.toThrow();
      }
    });

    it("should validate separator patterns", () => {
      const config = ConfigLoader.load("claude-code");
      const separatorPattern = config.noise_patterns.find((p) => p.type === "separator");

      expect(separatorPattern).toBeDefined();
    });
  });

  describe("echo pattern validation", () => {
    it("should validate echo pattern is valid regex", () => {
      const config = ConfigLoader.load("claude-code");

      expect(config.echo_pattern).toBeTruthy();
      if (config.echo_pattern) {
        expect(() => new RegExp(config.echo_pattern)).not.toThrow();
      }
    });

    it("should match health check patterns", () => {
      const config = ConfigLoader.load("claude-code");

      if (config.echo_pattern) {
        const regex = new RegExp(config.echo_pattern);
        expect(regex.test("HEALTH_1770407657040")).toBe(true);
        expect(regex.test("HEALTH_123456789")).toBe(true);
        expect(regex.test("not a health check")).toBe(false);
      }
    });
  });
});
