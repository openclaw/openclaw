import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";

let logPath = "";

beforeEach(() => {
  logPath = path.join(os.tmpdir(), `clawdbot-log-${crypto.randomUUID()}.log`);
  setLoggerOverride({ level: "info", file: logPath });
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

describe("logger redaction", () => {
  it("redacts passwords in structured log arguments", () => {
    const logger = getLogger();
    logger.info({
      mode: "password",
      password: "rmgDAriaMG$",
      allowTailscale: true,
    });

    const raw = fs.readFileSync(logPath, "utf8").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.mode).toBe("password");
    expect(parsed.password).toBe("***");
    expect(parsed.allowTailscale).toBe(true);
  });
});
