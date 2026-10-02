// Logger env tests cover log level and transport behavior from environment config.
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { getConsoleSettings } from "./console.js";
import { getResolvedLoggerSettings, resetLogger, setLoggerOverride } from "./logger.js";
import { loggingState } from "./state.js";

const defaultMaxFileBytes = 100 * 1024 * 1024;
const testLogPath = path.join(os.tmpdir(), "openclaw-test-env-log-level.log");

describe("OPENCLAW_LOG_LEVEL", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_LOG_LEVEL"]);
    delete process.env.OPENCLAW_LOG_LEVEL;
    loggingState.invalidEnvLogLevelValue = null;
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
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
    expect(getConsoleSettings()).toEqual({
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
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(getResolvedLoggerSettings().level).toBe("error");
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(defaultMaxFileBytes);
    expect(getConsoleSettings().level).toBe("warn");
    expect(getResolvedLoggerSettings().level).toBe("error");

    const warnings = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .filter((line) => line.includes("OPENCLAW_LOG_LEVEL"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ignoring invalid OPENCLAW_LOG_LEVEL="nope"');
  });

  it("structures invalid env warnings for JSON console output", () => {
    setLoggerOverride({
      level: "silent",
      consoleLevel: "info",
      consoleStyle: "json",
      file: testLogPath,
    });
    process.env.OPENCLAW_LOG_LEVEL = "nope";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(getConsoleSettings().level).toBe("info");

    const warning = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .find((line) => line.includes("OPENCLAW_LOG_LEVEL"));
    expect(JSON.parse(warning ?? "")).toMatchObject({
      level: "warn",
      message: expect.stringContaining('Ignoring invalid OPENCLAW_LOG_LEVEL="nope"'),
    });
  });
});
