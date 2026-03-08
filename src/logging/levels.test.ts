import { afterEach, describe, expect, it } from "vitest";
import { type LogLevel, levelToMinLevel, normalizeLogLevel } from "./levels.js";
import { isFileLogLevelEnabled } from "./logger.js";
import { loggingState } from "./state.js";

describe("levelToMinLevel", () => {
  it("maps levels to match tslog minLevel numbering (trace=1 .. fatal=6)", () => {
    // tslog minLevel: 0=silly, 1=trace, 2=debug, 3=info, 4=warn, 5=error, 6=fatal
    expect(levelToMinLevel("trace")).toBe(1);
    expect(levelToMinLevel("debug")).toBe(2);
    expect(levelToMinLevel("info")).toBe(3);
    expect(levelToMinLevel("warn")).toBe(4);
    expect(levelToMinLevel("error")).toBe(5);
    expect(levelToMinLevel("fatal")).toBe(6);
    expect(levelToMinLevel("silent")).toBe(Number.POSITIVE_INFINITY);
  });

  it("debug < info < warn (more verbose levels have lower minLevel values)", () => {
    // A logger with minLevel=debug should pass debug, info, warn, error, fatal.
    // tslog filters out entries whose level id is BELOW minLevel.
    // So debug(2) < info(3) < warn(4) must hold for correct filtering.
    expect(levelToMinLevel("debug")).toBeLessThan(levelToMinLevel("info"));
    expect(levelToMinLevel("info")).toBeLessThan(levelToMinLevel("warn"));
    expect(levelToMinLevel("warn")).toBeLessThan(levelToMinLevel("error"));
    expect(levelToMinLevel("error")).toBeLessThan(levelToMinLevel("fatal"));
    expect(levelToMinLevel("trace")).toBeLessThan(levelToMinLevel("debug"));
  });

  it("setting minLevel=debug allows debug calls through (tslog semantics)", () => {
    // tslog passes a log entry when entry.logLevelId >= minLevel.
    // debug entry has logLevelId=2, so minLevel must be <= 2 to pass.
    const minLevel = levelToMinLevel("debug");
    const debugLogLevelId = 2; // tslog: DEBUG=2
    expect(debugLogLevelId).toBeGreaterThanOrEqual(minLevel);
  });

  it("setting minLevel=info filters out debug calls (tslog semantics)", () => {
    const minLevel = levelToMinLevel("info");
    const debugLogLevelId = 2; // tslog: DEBUG=2
    expect(debugLogLevelId).toBeLessThan(minLevel);
  });
});

describe("normalizeLogLevel", () => {
  it("returns valid levels as-is", () => {
    expect(normalizeLogLevel("debug")).toBe("debug");
    expect(normalizeLogLevel("info")).toBe("info");
    expect(normalizeLogLevel("warn")).toBe("warn");
    expect(normalizeLogLevel("error")).toBe("error");
    expect(normalizeLogLevel("trace")).toBe("trace");
    expect(normalizeLogLevel("fatal")).toBe("fatal");
    expect(normalizeLogLevel("silent")).toBe("silent");
  });

  it("falls back for unknown levels", () => {
    expect(normalizeLogLevel("banana")).toBe("info");
    expect(normalizeLogLevel("banana", "debug")).toBe("debug");
  });

  it("falls back when undefined", () => {
    expect(normalizeLogLevel(undefined)).toBe("info");
    expect(normalizeLogLevel(undefined, "warn")).toBe("warn");
  });

  it("trims whitespace", () => {
    expect(normalizeLogLevel("  debug  ")).toBe("debug");
  });
});

describe("isFileLogLevelEnabled", () => {
  afterEach(() => {
    loggingState.cachedSettings = null;
  });

  function withLevel(level: string) {
    loggingState.cachedSettings = { level, file: "/tmp/test.log" };
  }

  it("info is enabled when settings level is debug", () => {
    withLevel("debug");
    expect(isFileLogLevelEnabled("info")).toBe(true);
  });

  it("debug is NOT enabled when settings level is info", () => {
    withLevel("info");
    expect(isFileLogLevelEnabled("debug")).toBe(false);
  });

  it("debug is enabled when settings level is debug", () => {
    withLevel("debug");
    expect(isFileLogLevelEnabled("debug")).toBe(true);
  });

  it("warn is enabled when settings level is debug", () => {
    withLevel("debug");
    expect(isFileLogLevelEnabled("warn")).toBe(true);
  });

  it("trace is NOT enabled when settings level is debug", () => {
    withLevel("debug");
    expect(isFileLogLevelEnabled("trace")).toBe(false);
  });

  it("nothing is enabled when settings level is silent", () => {
    withLevel("silent");
    expect(isFileLogLevelEnabled("debug")).toBe(false);
    expect(isFileLogLevelEnabled("info")).toBe(false);
    expect(isFileLogLevelEnabled("fatal")).toBe(false);
  });

  it("error is enabled when settings level is trace", () => {
    withLevel("trace");
    expect(isFileLogLevelEnabled("error")).toBe(true);
  });
});

describe("level comparison semantics (shouldLogToConsole pattern)", () => {
  // shouldLogToConsole is module-private but uses the same pattern:
  //   levelToMinLevel(entryLevel) >= levelToMinLevel(settings.level)
  // These tests validate the comparison direction is correct.

  function shouldEmit(entryLevel: LogLevel, configuredLevel: LogLevel): boolean {
    if (configuredLevel === "silent") {
      return false;
    }
    return levelToMinLevel(entryLevel) >= levelToMinLevel(configuredLevel);
  }

  it("warn passes when configured at info", () => {
    expect(shouldEmit("warn", "info")).toBe(true);
  });

  it("debug does NOT pass when configured at info", () => {
    expect(shouldEmit("debug", "info")).toBe(false);
  });

  it("info passes when configured at info (same level)", () => {
    expect(shouldEmit("info", "info")).toBe(true);
  });

  it("info passes when configured at debug", () => {
    expect(shouldEmit("info", "debug")).toBe(true);
  });

  it("fatal passes at every non-silent level", () => {
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      expect(shouldEmit("fatal", level)).toBe(true);
    }
  });

  it("trace only passes when configured at trace", () => {
    expect(shouldEmit("trace", "trace")).toBe(true);
    expect(shouldEmit("trace", "debug")).toBe(false);
    expect(shouldEmit("trace", "info")).toBe(false);
  });

  it("silent blocks everything", () => {
    expect(shouldEmit("fatal", "silent")).toBe(false);
  });
});
