import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getResolvedConsoleSettings,
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerOverride,
} from "../logging.js";
import { getChildLogger, registerLogTransport } from "./logger.js";
import { loggingState } from "./state.js";

const testLogPath = path.join(os.tmpdir(), "openclaw-test-env-log-level.log");
const defaultMaxFileBytes = 500 * 1024 * 1024;

describe("OPENCLAW_LOG_LEVEL", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OPENCLAW_LOG_LEVEL;
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

// tslog stores log arguments positionally: record["0"] is the first arg, or the prefix
// when using a sub-logger with bindings prefix. The level name is in _meta.logLevelName.
type TsLogRecord = Record<string, unknown> & {
  _meta?: { logLevelName?: string; logLevelId?: number };
};

describe("getChildLogger level inheritance", () => {
  beforeEach(() => {
    delete process.env.OPENCLAW_LOG_LEVEL;
    loggingState.invalidEnvLogLevelValue = null;
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    delete process.env.OPENCLAW_LOG_LEVEL;
    loggingState.invalidEnvLogLevelValue = null;
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
  });

  it("child logger without level override inherits parent minLevel — debug is suppressed when parent is info", () => {
    // Regression test for: child loggers created via getChildLogger() ignoring the
    // configured log level. Root cause: passing `minLevel: undefined` to tslog's
    // getSubLogger() causes it to override the parent minLevel with 0 (allow-all).
    setLoggerOverride({ level: "info", file: testLogPath });

    const captured: TsLogRecord[] = [];
    const unregister = registerLogTransport((record) => {
      captured.push(record as TsLogRecord);
    });

    try {
      const child = getChildLogger({ module: "test-child" });
      child.debug("should be filtered by parent level");
      child.info("should pass parent level");

      const debugRecords = captured.filter((r) => r._meta?.logLevelName === "DEBUG");
      const infoRecords = captured.filter((r) => r._meta?.logLevelName === "INFO");

      // DEBUG must be suppressed when parent is configured at "info" level
      expect(debugRecords).toHaveLength(0);
      // INFO must still pass through
      expect(infoRecords).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  it("child logger without bindings also inherits parent minLevel", () => {
    setLoggerOverride({ level: "info", file: testLogPath });

    const captured: TsLogRecord[] = [];
    const unregister = registerLogTransport((record) => {
      captured.push(record as TsLogRecord);
    });

    try {
      const child = getChildLogger(); // no bindings, no level override
      child.debug("debug — should be filtered");
      child.info("info — should pass");
      child.warn("warn — should pass");

      const debugRecords = captured.filter((r) => r._meta?.logLevelName === "DEBUG");
      const infoOrAbove = captured.filter(
        (r) =>
          r._meta?.logLevelName === "INFO" ||
          r._meta?.logLevelName === "WARN" ||
          r._meta?.logLevelName === "ERROR",
      );

      expect(debugRecords).toHaveLength(0);
      expect(infoOrAbove.length).toBeGreaterThanOrEqual(2);
    } finally {
      unregister();
    }
  });
});
