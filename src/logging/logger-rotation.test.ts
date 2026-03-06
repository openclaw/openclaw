import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";

describe("rolling file logger", () => {
  let logDir = "";

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-rotate-"));
    resetLogger();
    setLoggerOverride(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLogger();
    setLoggerOverride(null);
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("rotates rolling log writes when the local date changes", () => {
    const firstDay = new Date("2026-03-05T23:59:58");
    const secondDay = new Date("2026-03-06T00:00:02");
    const firstFile = path.join(logDir, "openclaw-2026-03-05.log");
    const secondFile = path.join(logDir, "openclaw-2026-03-06.log");

    vi.setSystemTime(firstDay);
    setLoggerOverride({ level: "info", file: firstFile });
    const logger = getLogger();

    logger.info("before-midnight");

    vi.setSystemTime(secondDay);
    logger.info("after-midnight");

    const firstContent = fs.readFileSync(firstFile, "utf8");
    const secondContent = fs.readFileSync(secondFile, "utf8");

    expect(firstContent).toContain("before-midnight");
    expect(firstContent).not.toContain("after-midnight");
    expect(secondContent).toContain("after-midnight");
    expect(secondContent).not.toContain("before-midnight");
  });
});
