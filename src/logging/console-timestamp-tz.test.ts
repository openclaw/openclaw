import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableConsoleCapture, setConsoleTimestampPrefix, setLoggerOverride } from "../logging.js";
import { loggingState } from "./state.js";

describe("formatConsoleTimestamp timezone support", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    loggingState.consolePatched = false;
    loggingState.forceConsoleToStderr = false;
    loggingState.consoleTimestampPrefix = false;
    loggingState.rawConsole = null;
  });

  afterEach(() => {
    process.env.TZ = originalTz;
    loggingState.consolePatched = false;
    loggingState.forceConsoleToStderr = false;
    loggingState.consoleTimestampPrefix = false;
    loggingState.rawConsole = null;
    vi.restoreAllMocks();
  });

  it("uses local time instead of UTC for pretty timestamps", () => {
    // Set timezone to Asia/Shanghai (UTC+8)
    process.env.TZ = "Asia/Shanghai";

    setLoggerOverride({ level: "info", file: "/tmp/test.log", consoleStyle: "pretty" });
    const log = vi.fn();
    console.log = log;

    // Use a specific UTC time: 2026-02-03T00:00:00.000Z
    // In Asia/Shanghai, this should be 08:00:00
    const testTime = new Date("2026-02-03T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(testTime);

    setConsoleTimestampPrefix(true);
    enableConsoleCapture();
    console.log("test message");

    expect(log).toHaveBeenCalledTimes(1);
    const firstArg = String(log.mock.calls[0]?.[0] ?? "");

    // Should show 08:00:00 (Shanghai time) not 00:00:00 (UTC)
    expect(firstArg).toMatch(/^08:00:00 test message$/);

    vi.useRealTimers();
  });

  it("respects different timezones", () => {
    // Set timezone to America/New_York (UTC-5 in winter)
    process.env.TZ = "America/New_York";

    setLoggerOverride({ level: "info", file: "/tmp/test.log", consoleStyle: "pretty" });
    const log = vi.fn();
    console.log = log;

    // Use a specific UTC time: 2026-02-03T05:30:00.000Z
    // In America/New_York (EST), this should be 00:30:00
    const testTime = new Date("2026-02-03T05:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(testTime);

    setConsoleTimestampPrefix(true);
    enableConsoleCapture();
    console.log("test message");

    expect(log).toHaveBeenCalledTimes(1);
    const firstArg = String(log.mock.calls[0]?.[0] ?? "");

    // Should show 00:30:00 (New York time) not 05:30:00 (UTC)
    expect(firstArg).toMatch(/^00:30:00 test message$/);

    vi.useRealTimers();
  });
});
