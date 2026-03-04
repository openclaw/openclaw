import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";

describe("logger timestamp format", () => {
  let logPath = "";

  beforeEach(() => {
    logPath = path.join(os.tmpdir(), `openclaw-log-ts-${crypto.randomUUID()}.log`);
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("uses local time format in file logs (not UTC)", () => {
    setLoggerOverride({ level: "info", file: logPath });
    const logger = getLogger();

    // Write a log entry
    logger.info("test-timestamp-format");

    // Read the log file
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    const lastLine = JSON.parse(lines[lines.length - 1]);

    // Should use local time format like "2026-02-27T15:04:00.000+08:00"
    // NOT UTC format like "2026-02-27T07:04:00.000Z"
    expect(lastLine.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(lastLine.time).not.toMatch(/Z$/);
  });
});
