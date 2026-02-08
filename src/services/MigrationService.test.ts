import fs from "node:fs";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { logWarn } from "../logger.js";
import { MigrationService } from "./MigrationService.js";

// Mock the logger to avoid console output during tests
vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

describe("MigrationService.getEnv", () => {
  let mockExistsSync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the strict mode cache before each test
    // @ts-expect-error - accessing private static for testing
    MigrationService.strictModeCache = undefined;
    mockExistsSync = vi.fn().mockReturnValue(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(fs, "existsSync").mockImplementation(mockExistsSync as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns OPENCLAW_* value when present", () => {
    const env = { OPENCLAW_GATEWAY_TOKEN: "new-token" };
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBe("new-token");
  });

  test("falls back to CLAWDBOT_* when OPENCLAW_* is undefined", () => {
    const env = { CLAWDBOT_GATEWAY_TOKEN: "legacy-token" };
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBe("legacy-token");
  });

  test("falls back to MOLTBOT_* when both OPENCLAW_* and CLAWDBOT_* are undefined", () => {
    const env = { MOLTBOT_GATEWAY_TOKEN: "ancient-token" };
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBe("ancient-token");
  });

  test("prefers OPENCLAW_* over CLAWDBOT_* when both are set", () => {
    const env = {
      OPENCLAW_GATEWAY_TOKEN: "new-token",
      CLAWDBOT_GATEWAY_TOKEN: "legacy-token",
    };
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBe("new-token");
  });

  test("prefers CLAWDBOT_* over MOLTBOT_* when both are set (no OPENCLAW_*)", () => {
    const env = {
      CLAWDBOT_GATEWAY_TOKEN: "legacy-token",
      MOLTBOT_GATEWAY_TOKEN: "ancient-token",
    };
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBe("legacy-token");
  });

  test("returns undefined when no matching env var exists", () => {
    const env = {};
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBeUndefined();
  });

  test("warns with the actual legacy key used", () => {
    const warn = vi.mocked(logWarn);
    const env = { MOLTBOT_GATEWAY_TOKEN: "ancient-token" };
    MigrationService.getEnv("GATEWAY_TOKEN", env);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("MOLTBOT_GATEWAY_TOKEN");
  });

  test("strict mode ignores legacy vars when ~/.openclaw exists", () => {
    mockExistsSync.mockReturnValue(true); // ~/.openclaw exists
    const env = { CLAWDBOT_GATEWAY_TOKEN: "legacy-token" };
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBeUndefined();
  });

  test("strict mode can be bypassed with OPENCLAW_ALLOW_LEGACY_ENV=1", () => {
    mockExistsSync.mockReturnValue(true); // ~/.openclaw exists
    const env = {
      CLAWDBOT_GATEWAY_TOKEN: "legacy-token",
      OPENCLAW_ALLOW_LEGACY_ENV: "1",
    };
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBe("legacy-token");
  });

  test("OPENCLAW_* still works in strict mode", () => {
    mockExistsSync.mockReturnValue(true); // ~/.openclaw exists
    const env = { OPENCLAW_GATEWAY_TOKEN: "new-token" };
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBe("new-token");
  });

  test("handles empty string as a valid value (not undefined)", () => {
    const env = { OPENCLAW_GATEWAY_TOKEN: "" };
    // Empty string is a defined value, should return it
    expect(MigrationService.getEnv("GATEWAY_TOKEN", env)).toBe("");
  });

  test("caches strict mode check for performance", () => {
    mockExistsSync.mockReturnValue(false);
    const env = { CLAWDBOT_GATEWAY_TOKEN: "token1" };

    // First call should check filesystem
    MigrationService.getEnv("GATEWAY_TOKEN", env);
    expect(mockExistsSync).toHaveBeenCalledTimes(1);

    // Second call should use cache
    MigrationService.getEnv("GATEWAY_PASSWORD", env);
    expect(mockExistsSync).toHaveBeenCalledTimes(1); // Still 1, not 2
  });
});
