import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "./logger.js";

describe("log file size cap", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-cap-"));
    logFile = path.join(tmpDir, "openclaw-test.log");
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stops writing when file exceeds 500 MB cap", () => {
    // Seed a file just under the 500 MB cap to avoid actually writing 500 MB.
    // The cap is 500 * 1024 * 1024 = 524_288_000 bytes.
    const capBytes = 500 * 1024 * 1024;
    const seedSize = capBytes - 128; // leave room for one more line
    // Create a sparse-ish file by writing a small marker then seeking.
    const fd = fs.openSync(logFile, "w");
    // Write filler to reach seedSize (use a buffer of zeros, efficient on disk).
    fs.ftruncateSync(fd, seedSize);
    fs.writeSync(fd, "prior-log-line\n", seedSize);
    fs.closeSync(fd);

    setLoggerOverride({ level: "info", file: logFile });
    const logger = getLogger();

    // First log should succeed (file is just under cap).
    logger.info("should-be-written");

    // Now we're over the cap — next writes should be suppressed.
    logger.info("should-be-suppressed-1");
    logger.info("should-be-suppressed-2");

    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toContain("should-be-written");
    expect(content).toContain("Log file size cap reached");
    expect(content).not.toContain("should-be-suppressed-1");
    expect(content).not.toContain("should-be-suppressed-2");
  });

  it("writes normally when file is below cap", () => {
    setLoggerOverride({ level: "info", file: logFile });
    const logger = getLogger();

    logger.info("line-1");
    logger.info("line-2");

    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toContain("line-1");
    expect(content).toContain("line-2");
  });
});
