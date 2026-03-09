import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setConsoleSubsystemFilter } from "./console.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { createSubsystemLogger } from "./subsystem.js";

function pathForTest() {
  const file = path.join(os.tmpdir(), `openclaw-sublog-${crypto.randomUUID()}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function cleanup(...files: string[]) {
  for (const f of files) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // ignore
    }
  }
}

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

// Regression: #37388 – log file does not rotate automatically on date change.
// Root cause: createSubsystemLogger cached its TsLogger child instance once
// and never invalidated it when the root logger rotated to a new dated file.
describe("createSubsystemLogger – log rotation on date change", () => {
  it("re-derives file logger when root logger rotates to a new date-based file", () => {
    const file1 = pathForTest();
    const file2 = pathForTest();

    // Day 1: create subsystem logger and emit a log entry
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: file1 });
    const logger = createSubsystemLogger("rotation-test");
    logger.info("day-one message");

    // Simulate midnight rotation: switch root logger to a new file
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: file2 });
    logger.info("day-two message");

    const c1 = fs.existsSync(file1) ? fs.readFileSync(file1, "utf-8") : "";
    const c2 = fs.existsSync(file2) ? fs.readFileSync(file2, "utf-8") : "";

    // Each message must land in the correct day's file
    expect(c1).toContain("day-one message");
    expect(c2).toContain("day-two message");

    // Guard: old file must NOT contain the new day's message (the original bug)
    expect(c1).not.toContain("day-two message");

    // Guard: new file must not be empty (the observed symptom)
    expect(c2.trim().length).toBeGreaterThan(0);

    cleanup(file1, file2);
  });

  it("does not recreate file logger unnecessarily on the same day", () => {
    const file1 = pathForTest();

    setLoggerOverride({ level: "info", consoleLevel: "silent", file: file1 });
    const logger = createSubsystemLogger("stable-test");

    logger.info("first call");
    logger.info("second call");
    logger.info("third call");

    const content = fs.readFileSync(file1, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(content).toContain("first call");
    expect(content).toContain("second call");
    expect(content).toContain("third call");

    cleanup(file1);
  });
});
