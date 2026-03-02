import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";
import { setConsoleSubsystemFilter, setConsoleTimestampPrefix } from "./console.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { createSubsystemLogger } from "./subsystem.js";

afterEach(() => {
  setConsoleSubsystemFilter(null);
  setConsoleTimestampPrefix(false);
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

  it("emits json console timestamps using local offset format (not UTC Z)", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
    const logger = createSubsystemLogger("hooks:loader");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("Registered hook");

    const line = String(logSpy.mock.calls.at(-1)?.[0] ?? "");
    const parsed = JSON.parse(line) as { time?: string };
    const time = parsed.time ?? "";
    expect(time).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(time.endsWith("Z")).toBe(false);
  });

  it("emits compact console timestamp prefix using local offset format when enabled", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    setConsoleTimestampPrefix(true);
    const logger = createSubsystemLogger("hooks:loader");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("Registered hook");

    const line = String(logSpy.mock.calls.at(-1)?.[0] ?? "");
    const plainLine = stripAnsi(line);
    expect(plainLine).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}\s/);
    expect(plainLine.includes("Z ")).toBe(false);
  });
});
