import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "./logger.js";

const MAX_LOG_FILE_BYTES = 20 * 1024 * 1024;

describe("logging file size cap", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates oversized files before appending new log lines", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-cap-"));
    tempDirs.push(tmpDir);
    const file = path.join(tmpDir, "openclaw.log");

    fs.writeFileSync(file, Buffer.alloc(MAX_LOG_FILE_BYTES + 128, "a"));
    expect(fs.statSync(file).size).toBeGreaterThan(MAX_LOG_FILE_BYTES);

    setLoggerOverride({ level: "info", file });
    const logger = getLogger();

    expect(fs.statSync(file).size).toBe(0);

    logger.info("line after startup cap reset");
    const firstWriteSize = fs.statSync(file).size;
    expect(firstWriteSize).toBeGreaterThan(0);
    expect(firstWriteSize).toBeLessThan(1024 * 1024);

    fs.writeFileSync(file, Buffer.alloc(MAX_LOG_FILE_BYTES + 128, "b"));
    logger.info("line after runtime cap reset");
    const secondWriteSize = fs.statSync(file).size;
    expect(secondWriteSize).toBeGreaterThan(0);
    expect(secondWriteSize).toBeLessThan(1024 * 1024);
  });
});
