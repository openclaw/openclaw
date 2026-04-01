import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";

describe("stale logger instances after rebuild", () => {
  let logDir = "";

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    if (logDir) {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      logDir = "";
    }
  });

  it("writes from a retained logger go to that logger file, not the rebuilt logger file", () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-stale-log-"));
    const fileA = path.join(logDir, "first.log");
    const fileB = path.join(logDir, "second.log");

    setLoggerOverride({ level: "info", file: fileA, maxFileBytes: 1024 * 1024 });
    const stale = getLogger();

    setLoggerOverride({ level: "info", file: fileB, maxFileBytes: 1024 * 1024 });
    getLogger();

    stale.info("from-stale-logger-instance");

    const a = fs.readFileSync(fileA, "utf8");
    const b = fs.readFileSync(fileB, "utf8");
    expect(a).toContain("from-stale-logger-instance");
    expect(b).not.toContain("from-stale-logger-instance");
  });
});
