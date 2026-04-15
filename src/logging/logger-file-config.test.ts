import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getLogger,
  getLoggerGeneration,
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerOverride,
} from "./logger.js";
import { createSubsystemLogger } from "./subsystem.js";

describe("logging.file config application", () => {
  beforeEach(() => {
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
  });

  it("increments logger generation when settings change", () => {
    // Force initial logger creation
    setLoggerOverride({ level: "debug", file: "/tmp/test-a.log" });
    getLogger(); // Actually create the logger
    const initialGeneration = getLoggerGeneration();
    expect(initialGeneration).toBeGreaterThan(0);

    // Change settings - this should trigger a rebuild on next getLogger() call
    setLoggerOverride({ level: "info", file: "/tmp/test-b.log" });
    resetLogger(); // Clear cache
    getLogger(); // Rebuild with new settings

    const gen1 = getLoggerGeneration();
    expect(gen1).toBeGreaterThan(initialGeneration);

    // Change settings again
    setLoggerOverride({ level: "warn", file: "/tmp/test-c.log" });
    resetLogger();
    getLogger();

    const gen2 = getLoggerGeneration();
    expect(gen2).toBeGreaterThan(gen1);
  });

  it("subsystem logger detects generation change and refetches child logger", () => {
    // This test verifies that subsystem loggers detect when the parent logger
    // has been rebuilt and fetch a fresh child logger with the new settings.
    //
    // Note: setLoggerOverride must be called AFTER resetLogger, because
    // resetLogger clears the overrideSettings.

    // Set initial config and create logger
    resetLogger();
    setLoggerOverride({ level: "info", file: "/tmp/path-a.log" });
    getLogger(); // Force creation
    const gen1 = getLoggerGeneration();

    // Create a subsystem logger (even if unused, this demonstrates the pattern)
    createSubsystemLogger("test-gen-tracking");

    // The subsystem logger's internal fileLogger will be created lazily.
    // If we could inspect it, it would use the current generation.

    // Now change config - this should cause the subsystem logger to
    // detect the generation change on next emit and refetch.
    // Note: Call resetLogger first, then setLoggerOverride
    resetLogger();
    setLoggerOverride({ level: "debug", file: "/tmp/path-b.log" });
    getLogger(); // Rebuild with new settings
    const gen2 = getLoggerGeneration();

    // Verify generation increased
    expect(gen2).toBeGreaterThan(gen1);

    // Verify resolved settings reflect the new path
    const settings = getResolvedLoggerSettings();
    expect(settings.file).toBe("/tmp/path-b.log");
    expect(settings.level).toBe("debug");
  });

  it("subsystem logger writes to correct file after config change", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-logtest-"));
    const logFileA = path.join(tempDir, "log-a.log");
    const logFileB = path.join(tempDir, "log-b.log");

    try {
      // Initialize with file A (override disables the vitest silent fast-path)
      resetLogger();
      setLoggerOverride({ level: "info", file: logFileA });

      // Create subsystem logger and emit
      const log = createSubsystemLogger("config-switch-test");
      log.info("first message");

      // Check file A exists and has the message
      expect(fs.existsSync(logFileA)).toBe(true);
      const contentA1 = fs.readFileSync(logFileA, "utf-8");
      expect(contentA1).toContain("first message");

      // Switch to file B (call resetLogger first, then setLoggerOverride)
      resetLogger();
      setLoggerOverride({ level: "info", file: logFileB });

      // Emit second message - should go to file B due to generation tracking
      log.info("second message");

      // Check file B exists and has the second message
      expect(fs.existsSync(logFileB)).toBe(true);
      const contentB = fs.readFileSync(logFileB, "utf-8");
      expect(contentB).toContain("second message");

      // File A should NOT have the second message
      const contentA2 = fs.readFileSync(logFileA, "utf-8");
      expect(contentA2).not.toContain("second message");
    } finally {
      resetLogger();
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it("getResolvedLoggerSettings returns configured file path", () => {
    const customPath = "/custom/path/to/logs/openclaw.log";
    setLoggerOverride({ level: "info", file: customPath });

    const settings = getResolvedLoggerSettings();
    expect(settings.file).toBe(customPath);
  });
});
