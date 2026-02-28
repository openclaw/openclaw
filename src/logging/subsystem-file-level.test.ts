import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { createSubsystemLogger } from "./subsystem.js";

const logPath = path.join(os.tmpdir(), "openclaw-test-subsystem-file-level.log");

afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
  try {
    fs.rmSync(logPath, { force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("createSubsystemLogger file level gating", () => {
  it("does not write debug entries to file when file level is info", () => {
    setLoggerOverride({ level: "info", file: logPath, consoleLevel: "silent" });
    const log = createSubsystemLogger("cron");

    log.debug("cron: timer armed");
    log.info("cron: started");

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("cron: started");
    expect(content).not.toContain("cron: timer armed");
  });
});
