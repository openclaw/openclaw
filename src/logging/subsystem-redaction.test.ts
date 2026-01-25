import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSubsystemLogger, resetLogger, setLoggerOverride } from "../logging.js";

type ConsoleSnapshot = {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
};

let snapshot: ConsoleSnapshot;
let logPath = "";

beforeEach(() => {
  snapshot = { log: console.log, warn: console.warn, error: console.error };
  logPath = path.join(os.tmpdir(), `clawdbot-log-${crypto.randomUUID()}.log`);
  resetLogger();
  setLoggerOverride({
    level: "info",
    file: logPath,
    consoleLevel: "info",
    consoleStyle: "json",
  });
});

afterEach(() => {
  console.log = snapshot.log;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  resetLogger();
  setLoggerOverride(null);
  try {
    fs.rmSync(logPath, { force: true });
  } catch {
    // ignore cleanup errors
  }
  vi.restoreAllMocks();
});

describe("subsystem logger redaction", () => {
  it("redacts sensitive meta fields in JSON console mode", () => {
    const log = vi.fn();
    console.log = log;

    const logger = createSubsystemLogger("gateway");
    logger.info("hello", { password: "secret", allowTailscale: true });

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.password).toBe("***");
    expect(parsed.allowTailscale).toBe(true);
    expect(parsed.message).toBe("hello");
  });
});
