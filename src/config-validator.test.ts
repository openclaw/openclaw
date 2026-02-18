/**
 * Tests for config-validator.ts
 */

import { validateConfigFile, logConfigValidation } from "./config-validator";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Config Validator", () => {
  let tempDir: string;
  let testConfigPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    testConfigPath = path.join(tempDir, "openclaw.json");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("validateConfigFile", () => {
    it("should fail when file does not exist", () => {
      const result = validateConfigFile("/nonexistent/path/openclaw.json");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("not found");
    });

    it("should fail on invalid JSON syntax", () => {
      fs.writeFileSync(testConfigPath, '{"broken": json}');
      const result = validateConfigFile(testConfigPath);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Invalid JSON");
    });

    it("should fail on unclosed brace", () => {
      fs.writeFileSync(testConfigPath, '{"agents": {"defaults": {}}');
      const result = validateConfigFile(testConfigPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("JSON"))).toBe(true);
    });

    it("should succeed with valid minimal config", () => {
      fs.writeFileSync(
        testConfigPath,
        JSON.stringify({
          agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } },
        })
      );
      const result = validateConfigFile(testConfigPath);
      expect(result.valid).toBe(true);
      expect(result.config).toBeDefined();
    });

    it("should fail if agents.defaults.models is not an object", () => {
      fs.writeFileSync(
        testConfigPath,
        JSON.stringify({
          agents: { defaults: { models: "not-an-object" } },
        })
      );
      const result = validateConfigFile(testConfigPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("models must be an object"))).toBe(true);
    });

    it("should warn when model listed but auth profile missing", () => {
      fs.writeFileSync(
        testConfigPath,
        JSON.stringify({
          agents: { defaults: { models: { "openai/gpt-4": {} } } },
          auth: { profiles: {} },
        })
      );
      const result = validateConfigFile(testConfigPath);
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("openai/gpt-4");
    });

    it("should warn about Moonshot API key without auth profile", () => {
      fs.writeFileSync(
        testConfigPath,
        JSON.stringify({
          env: { MOONSHOT_API_KEY: "sk-..." },
          auth: { profiles: {} },
        })
      );
      const result = validateConfigFile(testConfigPath);
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("MOONSHOT"))).toBe(true);
    });

    it("should provide helpful error messages for common mistakes", () => {
      // Missing closing brace
      fs.writeFileSync(testConfigPath, '{"agents": {');
      const result = validateConfigFile(testConfigPath);
      expect(result.errors.some((e) => e.includes("JSON"))).toBe(true);
      expect(result.errors.some((e) => e.includes("Unclosed"))).toBe(true);
    });
  });

  describe("logConfigValidation", () => {
    it("should log valid config successfully", () => {
      const consoleSpy = jest.spyOn(console, "log");
      const result = { valid: true, errors: [], warnings: [], filePath: "/path/to/config" };
      logConfigValidation(result);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("✅ VALID"));
      consoleSpy.mockRestore();
    });

    it("should log errors with details", () => {
      const consoleErrorSpy = jest.spyOn(console, "error");
      const result = {
        valid: false,
        errors: ["Test error"],
        warnings: [],
        filePath: "/path/to/config",
      };
      logConfigValidation(result);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("❌ INVALID"));
      consoleErrorSpy.mockRestore();
    });

    it("should log warnings when present", () => {
      const consoleWarnSpy = jest.spyOn(console, "warn");
      const result = {
        valid: true,
        errors: [],
        warnings: ["Test warning"],
        filePath: "/path/to/config",
      };
      logConfigValidation(result);
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("Test warning"));
      consoleWarnSpy.mockRestore();
    });
  });
});
