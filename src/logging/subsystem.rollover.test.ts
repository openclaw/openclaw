import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { loggingState } from "./state.js";

const getChildLogger = vi.hoisted(() => vi.fn());
const isFileLogLevelEnabled = vi.hoisted(() => vi.fn(() => true));

vi.mock("./logger.js", async () => {
  const actual = await vi.importActual<typeof import("./logger.js")>("./logger.js");
  return {
    ...actual,
    getChildLogger,
    isFileLogLevelEnabled,
  };
});

vi.mock("./console.js", () => ({
  formatConsoleTimestamp: () => "",
  getConsoleSettings: () => ({ level: "silent", style: "compact" }),
  shouldLogSubsystemToConsole: () => false,
}));

vi.mock("../global-state.js", () => ({
  isVerbose: () => false,
}));

vi.mock("../terminal/progress-line.js", () => ({
  clearActiveProgressLine: () => {},
}));

vi.mock("../utils/message-channel.js", () => ({
  normalizeMessageChannel: (value: string) => value,
}));

import { createSubsystemLogger } from "./subsystem.js";

describe("createSubsystemLogger file rollover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T10:00:00Z"));
    getChildLogger.mockReset();
    isFileLogLevelEnabled.mockReset();
    isFileLogLevelEnabled.mockReturnValue(true);
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
  });

  afterEach(() => {
    resetLogger();
    vi.clearAllTimers();
    vi.useRealTimers();
    loggingState.cachedLogger = null;
  });

  it("reuses the child file logger within the same day", () => {
    const fileLogger = { info: vi.fn() };
    getChildLogger.mockReturnValue(fileLogger as never);

    const log = createSubsystemLogger("diagnostic");

    log.info("first log line");
    log.info("second log line");

    expect(getChildLogger).toHaveBeenCalledTimes(1);
    expect(fileLogger.info).toHaveBeenNthCalledWith(1, "first log line");
    expect(fileLogger.info).toHaveBeenNthCalledWith(2, "second log line");
  });

  it("refreshes the child file logger after the local date changes", () => {
    const firstFileLogger = { info: vi.fn() };
    const secondFileLogger = { info: vi.fn() };
    getChildLogger
      .mockReturnValueOnce(firstFileLogger as never)
      .mockReturnValueOnce(secondFileLogger as never);

    const log = createSubsystemLogger("diagnostic");

    log.info("first log line");
    vi.setSystemTime(new Date("2026-04-08T10:00:00Z"));
    log.info("second log line");

    expect(getChildLogger).toHaveBeenCalledTimes(2);
    expect(firstFileLogger.info).toHaveBeenCalledWith("first log line");
    expect(secondFileLogger.info).toHaveBeenCalledWith("second log line");
  });

  it("refreshes the child file logger after the cached base logger resets", () => {
    const firstFileLogger = { info: vi.fn() };
    const secondFileLogger = { info: vi.fn() };
    getChildLogger
      .mockReturnValueOnce(firstFileLogger as never)
      .mockReturnValueOnce(secondFileLogger as never);

    const log = createSubsystemLogger("diagnostic");

    log.info("first log line");
    loggingState.cachedLogger = { replaced: true } as never;
    log.info("second log line");

    expect(getChildLogger).toHaveBeenCalledTimes(2);
    expect(firstFileLogger.info).toHaveBeenCalledWith("first log line");
    expect(secondFileLogger.info).toHaveBeenCalledWith("second log line");
  });
});
