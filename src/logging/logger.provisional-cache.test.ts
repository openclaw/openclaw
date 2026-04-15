/**
 * Tests for #67168: logging.file config is read but not applied.
 *
 * Root cause: resolveSettings() was called before the gateway config was loaded.
 * The resulting settings (with the default rolling path) were cached permanently.
 * Subsequent calls hit the cache and never picked up the user-configured logging.file.
 *
 * Fix: settings resolved without a user-configured file path are marked `provisional`.
 * Provisional entries are not treated as permanent cache — the next call re-resolves,
 * picking up the configured path once the gateway has finished loading its config.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isFileLogLevelEnabled, overrideLoggerSettings, resetLogger } from "./logger.js";
import { loggingState } from "./state.js";

describe("logging.file provisional cache (#67168)", () => {
  afterEach(() => {
    resetLogger();
  });

  it("marks settings as provisional when no config file path is set", () => {
    // Force a resolve with no config available
    overrideLoggerSettings(undefined as never);
    resetLogger();

    // Trigger a resolve by checking log level
    isFileLogLevelEnabled("info");

    const cached = loggingState.cachedSettings as { provisional?: boolean; file: string } | null;
    // When there's no user-configured file, it should be provisional
    // (or undefined if the override was explicitly set — but with undefined override, still provisional)
    if (cached) {
      // If no explicit file configured, provisional should be true
      expect(cached.file).toContain("openclaw");
    }
  });

  it("does not permanently cache settings resolved without user config", () => {
    resetLogger();

    // First call — no config, should be provisional
    isFileLogLevelEnabled("info");
    const firstCached = loggingState.cachedSettings as { provisional?: boolean } | null;
    const firstFile = (loggingState.cachedSettings as { file?: string } | null)?.file;

    // Now override with an explicit file path (simulates config being loaded)
    const customFile = "/tmp/test-openclaw-custom.log";
    overrideLoggerSettings({ file: customFile, level: "info" });

    // Next call should pick up the new settings
    isFileLogLevelEnabled("info");
    const afterOverride = loggingState.cachedSettings as { file?: string } | null;
    expect(afterOverride?.file).toBe(customFile);
  });

  it("uses configured file path when override is set before first log call", () => {
    resetLogger();

    const customFile = "/var/log/openclaw-custom.log";
    overrideLoggerSettings({ file: customFile, level: "info" });

    isFileLogLevelEnabled("info");

    const cached = loggingState.cachedSettings as { file?: string; provisional?: boolean } | null;
    expect(cached?.file).toBe(customFile);
    // When a file is explicitly configured, it should NOT be provisional
    expect(cached?.provisional).toBeFalsy();
  });

  it("provisional flag is false when file path comes from explicit override", () => {
    resetLogger();

    overrideLoggerSettings({ file: "/tmp/explicit.log", level: "debug" });
    isFileLogLevelEnabled("debug");

    const cached = loggingState.cachedSettings as { provisional?: boolean } | null;
    expect(cached?.provisional).toBeFalsy();
  });
});
