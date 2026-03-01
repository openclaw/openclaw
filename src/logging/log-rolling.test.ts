import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";

/** Produces "YYYY-MM-DD" in local time, matching the logger's own helper. */
function localDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function rollingLogName(date: Date): string {
  return `openclaw-${localDateStr(date)}.log`;
}

describe("log rolling", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rolling-"));
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("prunes previous-day log files when initialising a rolling logger", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayFile = path.join(tmpDir, rollingLogName(yesterday));
    fs.writeFileSync(yesterdayFile, "stale log content\n");

    const today = new Date();
    const todayFile = path.join(tmpDir, rollingLogName(today));

    setLoggerOverride({ level: "info", file: todayFile });
    // Calling getLogger() triggers buildLogger() → pruneOldRollingLogs()
    getLogger().info("first write");

    expect(fs.existsSync(yesterdayFile)).toBe(false);
    expect(fs.existsSync(todayFile)).toBe(true);
  });

  it("does not prune today's log file", () => {
    const today = new Date();
    const todayFile = path.join(tmpDir, rollingLogName(today));
    fs.writeFileSync(todayFile, "today content\n");

    setLoggerOverride({ level: "info", file: todayFile });
    getLogger().info("second write");

    expect(fs.existsSync(todayFile)).toBe(true);
  });

  it("enforces size cap after external writes grow the file beyond maxFileBytes", () => {
    const todayFile = path.join(tmpDir, rollingLogName(new Date()));
    const maxBytes = 1024; // 1 KB cap

    setLoggerOverride({ level: "info", file: todayFile, maxFileBytes: maxBytes });
    const logger = getLogger();

    // Write a handful of lines via the logger so currentFileBytes is primed.
    for (let i = 0; i < 5; i++) {
      logger.info(`seed-${i}`);
    }
    const sizeAfterSeed = fs.statSync(todayFile).size;

    // Simulate a concurrent writer filling the file to the cap boundary.
    const fillBytes = maxBytes - sizeAfterSeed;
    if (fillBytes > 0) {
      fs.appendFileSync(todayFile, Buffer.alloc(fillBytes, 0x78 /* 'x' */));
    }

    // Write more than BYTES_RESYNC_WRITES (100) lines so the logger re-reads
    // the actual file size and detects the cap.
    for (let i = 0; i < 110; i++) {
      logger.info(`post-fill-${i}-${"z".repeat(20)}`);
    }

    const finalSize = fs.statSync(todayFile).size;
    // After re-sync the logger must stop writing; allow a small margin for the
    // single warning line that is flushed when the cap is first hit.
    expect(finalSize).toBeLessThanOrEqual(maxBytes + 512);
  });
});
