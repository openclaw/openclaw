import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loggingState } from "./state.js";
import { setLoggerOverride } from "../logging/logger.js";

describe("subsystem timestamp timezone support", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    loggingState.consolePatched = false;
    loggingState.forceConsoleToStderr = false;
    loggingState.consoleTimestampPrefix = false;
    loggingState.rawConsole = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env.TZ = originalTz;
    loggingState.consolePatched = false;
    loggingState.forceConsoleToStderr = false;
    loggingState.consoleTimestampPrefix = false;
    loggingState.rawConsole = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses local time for subsystem logs when TZ is set", () => {
    process.env.TZ = "Asia/Shanghai";

    // We need to mock console.log/info because subsystem logger writes to them
    const log = vi.fn();
    console.log = log;
    console.info = log;

    // Explicitly set console style to pretty to trigger the timestamp logic
    setLoggerOverride({ level: "info", file: "/tmp/test-subsystem.log", consoleStyle: "pretty" });

    // 2026-02-03T00:00:00.000Z -> 08:00:00 in Shanghai
    const testTime = new Date("2026-02-03T00:00:00.000Z");
    vi.setSystemTime(testTime);

    const logger = createSubsystemLogger("test/subsystem");
    logger.info("test message");

    expect(log).toHaveBeenCalled();
    const callArgs = log.mock.calls[0]?.[0];
    // Subsystem logs are colored, so we might need to check content loosely or strip ansi
    // But basic check: it should contain the time
    expect(callArgs).toContain("08:00:00");
  });
});
