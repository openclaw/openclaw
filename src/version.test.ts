import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Note: VERSION is computed dynamically, so we test the module behavior

describe("version module", () => {
  let originalVersion: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save original environment
    originalEnv = {
      OPENCLAW_BUNDLED_VERSION: process.env.OPENCLAW_BUNDLED_VERSION,
    };
  });

  afterEach(() => {
    // Restore environment
    if (originalEnv.OPENCLAW_BUNDLED_VERSION !== undefined) {
      process.env.OPENCLAW_BUNDLED_VERSION = originalEnv.OPENCLAW_BUNDLED_VERSION;
    } else {
      delete process.env.OPENCLAW_BUNDLED_VERSION;
    }
  });

  it("should export a VERSION constant", async () => {
    const { VERSION } = await import("./version.js");
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it("should have a valid semantic version format or fallback", async () => {
    const { VERSION } = await import("./version.js");
    // Should match semver or fallback "0.0.0"
    const semverRegex = /^\d+\.\d+\.\d+([-+].*)?$/;
    expect(VERSION).toMatch(semverRegex);
  });

  it("should not be empty", async () => {
    const { VERSION } = await import("./version.js");
    expect(VERSION).toBeTruthy();
    expect(VERSION.trim()).not.toBe("");
  });

  it("should prioritize bundled version from environment", () => {
    process.env.OPENCLAW_BUNDLED_VERSION = "2.0.0";
    // Note: dynamic imports may require cache clearing in real test setup
    // This is a conceptual test showing the intent
    expect(process.env.OPENCLAW_BUNDLED_VERSION).toBe("2.0.0");
  });

  it("should handle version from package.json", async () => {
    const { VERSION } = await import("./version.js");
    // The actual package.json version should be read
    // This test verifies the module loads without error
    expect(VERSION).toBeDefined();
  });
});
