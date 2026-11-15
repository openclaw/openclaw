// Tests root logger formatting and file output behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { theme } from "../packages/terminal-core/src/theme.js";
import { isVerbose, isYes, logVerbose, setVerbose, setYes } from "./globals.js";
import { logDebug, logError, logInfo, logWarn } from "./logger.js";
import { flushLogger, resetLogger, setLoggerOverride } from "./logging/logger.js";
import type { RuntimeEnv } from "./runtime.js";
import { withTestDir } from "./test-helpers/temp-dir.js";

describe("logger helpers", () => {
  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    setVerbose(false);
    setYes(false);
  });

  it("formats messages through runtime log/error", () => {
    const log = vi.fn();
    const error = vi.fn();
    const runtime: RuntimeEnv = { log, error, exit: vi.fn() };

    logInfo("info", runtime);
    logWarn("warn", runtime);
    logError("bad", runtime);

    expect(log).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("only logs debug when verbose is enabled", () => {
    const logVerboseLocal = vi.spyOn(console, "log").mockImplementation(() => {});
    setVerbose(false);
    logDebug("quiet");
    expect(logVerboseLocal).not.toHaveBeenCalled();

    setVerbose(true);
    logVerboseLocal.mockClear();
    logDebug("loud");
    expect(logVerboseLocal).toHaveBeenCalled();
    logVerboseLocal.mockRestore();
  });

  it("filters messages below configured level", async () => {
    await withTestDir({ prefix: "openclaw-log-test-" }, async (dir) => {
      const logPath = path.join(dir, "openclaw.log");
      setLoggerOverride({ level: "warn", file: logPath });
      logInfo("info-only");
      logWarn("warn-only");
      // The file transport appends asynchronously; drain it before reading.
      await flushLogger();
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("warn-only");
    });
  });
});

describe("globals", () => {
  afterEach(() => {
    setVerbose(false);
    setYes(false);
    vi.restoreAllMocks();
  });

  it("toggles verbose flag and logs when enabled", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setVerbose(false);
    logVerbose("hidden");
    expect(logSpy).not.toHaveBeenCalled();

    setVerbose(true);
    logVerbose("shown");
    expect(isVerbose()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(theme.muted("shown"));
  });

  it("stores yes flag", () => {
    setYes(true);
    expect(isYes()).toBe(true);
    setYes(false);
    expect(isYes()).toBe(false);
  });
});
