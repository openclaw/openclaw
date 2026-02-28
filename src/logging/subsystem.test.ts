import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setConsoleSubsystemFilter } from "./console.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { createSubsystemLogger } from "./subsystem.js";

afterEach(() => {
  setConsoleSubsystemFilter(null);
  setLoggerOverride(null);
  resetLogger();
  vi.restoreAllMocks();
});

describe("createSubsystemLogger().isEnabled", () => {
  it("returns true for any/file when only file logging would emit", () => {
    setLoggerOverride({ level: "debug", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(false);
  });

  it("returns true for any/console when only console logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "debug" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("returns false when neither console nor file logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(false);
    expect(log.isEnabled("debug", "console")).toBe(false);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("honors console subsystem filters for console target", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "console")).toBe(false);
  });

  it("does not apply console subsystem filters to file target", () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "file")).toBe(true);
    expect(log.isEnabled("info")).toBe(true);
  });
});

describe("createSubsystemLogger() file log emission", () => {
  it("does not write debug logs to file when file level is info", () => {
    const logFile = path.join(os.tmpdir(), `openclaw-subsystem-${Date.now()}-debug.log`);
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: logFile });
    const log = createSubsystemLogger("cron");

    log.debug("cron: timer armed", { nextAt: 1 });

    const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    expect(content.includes("cron: timer armed")).toBe(false);
    fs.rmSync(logFile, { force: true });
  });

  it("writes info logs to file when file level is info", () => {
    const logFile = path.join(os.tmpdir(), `openclaw-subsystem-${Date.now()}-info.log`);
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: logFile });
    const log = createSubsystemLogger("cron");

    log.info("cron: timer armed", { nextAt: 1 });

    const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    expect(content.includes("cron: timer armed")).toBe(true);
    fs.rmSync(logFile, { force: true });
  });
});
