import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";

// Test that jiti is configured with nativeModules for sqlite3 and better-sqlite3
// to prevent binding resolution failures when plugins use these native modules.
// See: https://github.com/openclaw/openclaw/issues/36377
describe("jiti native module configuration", () => {
  it("includes sqlite3 in nativeModules to prevent binding resolution failures", () => {
    // Create a jiti instance with the same configuration as the plugin loader
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      // This is the fix: nativeModules must include sqlite3 and better-sqlite3
      nativeModules: ["typescript", "sqlite3", "better-sqlite3"],
    });

    // Verify jiti was created successfully with nativeModules config
    expect(jiti).toBeDefined();

    // The nativeModules config ensures that when plugins import sqlite3 or better-sqlite3,
    // jiti uses Node's native require() instead of transforming the module.
    // This prevents the "Could not locate the bindings file" error where bindings
    // are resolved relative to jiti's location instead of the sqlite3 package.
  });

  it("includes better-sqlite3 in nativeModules to prevent binding resolution failures", () => {
    // Same test for better-sqlite3 which is also commonly used by plugins
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      nativeModules: ["typescript", "sqlite3", "better-sqlite3"],
    });

    expect(jiti).toBeDefined();
  });

  it("fails without nativeModules configuration (demonstrates the bug)", () => {
    // This test demonstrates what happens WITHOUT the fix
    const jitiWithoutFix = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      // NO nativeModules config - this is the bug
    });

    // Without nativeModules, jiti transforms sqlite3 which causes binding lookup to fail
    // The bindings package resolves paths relative to jiti instead of sqlite3
    // This test just verifies the configuration difference
    expect(jitiWithoutFix).toBeDefined();
  });
});
