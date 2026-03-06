import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";

describe("logger daily rolling rotation", () => {
  let logDir = "";
  let dayOnePath = "";
  let dayTwoPath = "";

  beforeEach(() => {
    logDir = path.join(os.tmpdir(), `openclaw-log-rotate-${crypto.randomUUID()}`);
    dayOnePath = path.join(logDir, "openclaw-2026-03-05.log");
    dayTwoPath = path.join(logDir, "openclaw-2026-03-06.log");
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

  it("switches to the new day's file after midnight without restart", () => {
    vi.setSystemTime(new Date("2026-03-05T23:59:58"));
    setLoggerOverride({ level: "info", file: dayOnePath });
    const logger = getLogger();

    logger.info("before-midnight");
    vi.setSystemTime(new Date("2026-03-06T00:00:02"));
    logger.info("after-midnight");

    const dayOneContent = fs.readFileSync(dayOnePath, "utf8");
    const dayTwoContent = fs.readFileSync(dayTwoPath, "utf8");

    expect(dayOneContent).toContain("before-midnight");
    expect(dayOneContent).not.toContain("after-midnight");
    expect(dayTwoContent).toContain("after-midnight");
  });
});
