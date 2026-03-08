import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setConsoleSubsystemFilter } from "./console.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { createSubsystemLogger } from "./subsystem.js";

afterEach(() => {
  setConsoleSubsystemFilter(null);
  setLoggerOverride(null);
  resetLogger();
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

describe("subsystem logger follows root logger rotation (#37388)", () => {
  it("writes to new log file after root logger is rebuilt", () => {
    const tmpDir = path.join(os.tmpdir(), `openclaw-log-rotate-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const file1 = path.join(tmpDir, "openclaw-day1.log");
    const file2 = path.join(tmpDir, "openclaw-day2.log");

    try {
      // Start with file1
      setLoggerOverride({ level: "info", file: file1 });
      const log = createSubsystemLogger("test-subsystem");
      log.info("message-day1");

      // Simulate date change: switch to file2 (setLoggerOverride
      // clears the cached logger and bumps generation, just like
      // resolveSettings would when the date rolls over).
      setLoggerOverride({ level: "info", file: file2 });
      // Write via the same subsystem logger instance
      log.info("message-day2");

      const content1 = fs.existsSync(file1) ? fs.readFileSync(file1, "utf8") : "";
      const content2 = fs.existsSync(file2) ? fs.readFileSync(file2, "utf8") : "";

      expect(content1).toContain("message-day1");
      expect(content1).not.toContain("message-day2");
      expect(content2).toContain("message-day2");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
