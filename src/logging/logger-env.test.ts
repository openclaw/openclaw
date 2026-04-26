import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getResolvedConsoleSettings,
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerOverride,
} from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { loggingState } from "./state.js";

const defaultMaxFileBytes = 500 * 1024 * 1024;
const logPathTracker = createSuiteLogPathTracker("openclaw-test-env-log-level-");

describe("OPENCLAW_LOG_LEVEL", () => {
  let originalEnv: string | undefined;
  let testLogPath = "";

  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    originalEnv = process.env.OPENCLAW_LOG_LEVEL;
    testLogPath = logPathTracker.nextPath();
    delete process.env.OPENCLAW_LOG_LEVEL;
    loggingState.invalidEnvLogLevelValue = null;
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_LOG_LEVEL;
    } else {
      process.env.OPENCLAW_LOG_LEVEL = originalEnv;
    }
    loggingState.invalidEnvLogLevelValue = null;
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
    testLogPath = "";
  });

  it("applies a valid env override to both file and console levels", () => {
    setLoggerOverride({
      level: "error",
      consoleLevel: "warn",
      consoleStyle: "json",
      file: testLogPath,
    });
    process.env.OPENCLAW_LOG_LEVEL = "debug";

    expect(getResolvedLoggerSettings()).toEqual({
      level: "debug",
      file: testLogPath,
      maxFileBytes: defaultMaxFileBytes,
    });
    expect(getResolvedConsoleSettings()).toEqual({
      level: "debug",
      style: "json",
    });
  });

  it("warns once and ignores invalid env values", () => {
    setLoggerOverride({
      level: "error",
      consoleLevel: "warn",
      consoleStyle: "compact",
      file: testLogPath,
    });
    process.env.OPENCLAW_LOG_LEVEL = "nope";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true as unknown as ReturnType<typeof process.stderr.write>, // preserve stream contract in test spy
    );

    expect(getResolvedLoggerSettings().level).toBe("error");
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(defaultMaxFileBytes);
    expect(getResolvedConsoleSettings().level).toBe("warn");
    expect(getResolvedLoggerSettings().level).toBe("error");

    const warnings = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .filter((line) => line.includes("OPENCLAW_LOG_LEVEL"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ignoring invalid OPENCLAW_LOG_LEVEL="nope"');
  });
});

describe("OPENCLAW_LOG_MAX_FILE_BYTES (#71800)", () => {
  let originalEnv: string | undefined;
  let testLogPath = "";

  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    originalEnv = process.env.OPENCLAW_LOG_MAX_FILE_BYTES;
    testLogPath = logPathTracker.nextPath();
    delete process.env.OPENCLAW_LOG_MAX_FILE_BYTES;
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_LOG_MAX_FILE_BYTES;
    } else {
      process.env.OPENCLAW_LOG_MAX_FILE_BYTES = originalEnv;
    }
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
    testLogPath = "";
  });

  it("env override beats config-load race so plist/launchd unit values apply at first log write", () => {
    setLoggerOverride({
      level: "info",
      consoleLevel: "warn",
      consoleStyle: "compact",
      file: testLogPath,
      maxFileBytes: defaultMaxFileBytes,
    });
    process.env.OPENCLAW_LOG_MAX_FILE_BYTES = "1073741824";

    expect(getResolvedLoggerSettings().maxFileBytes).toBe(1073741824);
  });

  it("ignores empty / whitespace-only env values and falls back to config / default", () => {
    setLoggerOverride({
      level: "info",
      consoleLevel: "warn",
      consoleStyle: "compact",
      file: testLogPath,
      maxFileBytes: defaultMaxFileBytes,
    });
    process.env.OPENCLAW_LOG_MAX_FILE_BYTES = "   ";

    expect(getResolvedLoggerSettings().maxFileBytes).toBe(defaultMaxFileBytes);
  });

  it("ignores non-numeric / zero / negative / non-finite env values", () => {
    for (const bad of ["one-gig", "0", "-1", "Infinity", "NaN"]) {
      process.env.OPENCLAW_LOG_MAX_FILE_BYTES = bad;
      // setLoggerOverride MUST be inside the loop: resetLogger() clears
      // overrideSettings, which lets canUseSilentVitestFileLogFastPath
      // short-circuit resolveSettings() before resolveMaxLogFileBytesFromEnv()
      // is reached. Without this re-arm the assertions pass vacuously and the
      // env validator is never exercised. (greptile review on PR #71917)
      setLoggerOverride({
        level: "info",
        consoleLevel: "warn",
        consoleStyle: "compact",
        file: testLogPath,
        maxFileBytes: defaultMaxFileBytes,
      });
      expect(getResolvedLoggerSettings().maxFileBytes).toBe(defaultMaxFileBytes);
    }
  });

  it("floors fractional env values", () => {
    setLoggerOverride({
      level: "info",
      consoleLevel: "warn",
      consoleStyle: "compact",
      file: testLogPath,
      maxFileBytes: defaultMaxFileBytes,
    });
    process.env.OPENCLAW_LOG_MAX_FILE_BYTES = "1024.7";

    expect(getResolvedLoggerSettings().maxFileBytes).toBe(1024);
  });

  it("clamps env override to 2 GiB to prevent disk-fill DoS via env injection (CWE-400)", () => {
    setLoggerOverride({
      level: "info",
      consoleLevel: "warn",
      consoleStyle: "compact",
      file: testLogPath,
      maxFileBytes: defaultMaxFileBytes,
    });
    // 1 TiB attempted; clamps to 2 GiB ceiling.
    process.env.OPENCLAW_LOG_MAX_FILE_BYTES = String(1024 * 1024 * 1024 * 1024);

    expect(getResolvedLoggerSettings().maxFileBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it("respects env values at or below the 2 GiB cap", () => {
    setLoggerOverride({
      level: "info",
      consoleLevel: "warn",
      consoleStyle: "compact",
      file: testLogPath,
      maxFileBytes: defaultMaxFileBytes,
    });
    process.env.OPENCLAW_LOG_MAX_FILE_BYTES = String(2 * 1024 * 1024 * 1024);

    expect(getResolvedLoggerSettings().maxFileBytes).toBe(2 * 1024 * 1024 * 1024);
  });
});
