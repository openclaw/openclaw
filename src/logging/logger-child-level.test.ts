import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getChildLogger, resetLogger, setLoggerOverride } from "./logger.js";

const logPath = path.join(os.tmpdir(), "openclaw-test-child-level.log");

afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
  try {
    fs.rmSync(logPath, { force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("getChildLogger", () => {
  it("inherits configured file level when explicit child level is not provided", () => {
    setLoggerOverride({ level: "info", file: logPath, consoleLevel: "silent" });
    const logger = getChildLogger({ module: "cron" });

    logger.debug("cron: timer armed");
    logger.info("cron: started");

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("cron: started");
    expect(content).not.toContain("cron: timer armed");
  });
});
