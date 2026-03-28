import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLogger,
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerOverride,
} from "../logging.js";

const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024;

describe("log file size cap", () => {
  let logPath = "";
  let originalUmask = 0;

  beforeEach(() => {
    logPath = path.join(os.tmpdir(), `openclaw-log-cap-${crypto.randomUUID()}.log`);
    originalUmask = process.umask();
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    process.umask(originalUmask);
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("defaults maxFileBytes to 500 MB when unset", () => {
    setLoggerOverride({ level: "info", file: logPath });
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("uses configured maxFileBytes", () => {
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 2048 });
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(2048);
  });

  it("suppresses file writes after cap is reached and warns once", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true as unknown as ReturnType<typeof process.stderr.write>, // preserve stream contract in test spy
    );
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 1024 });
    const logger = getLogger();

    for (let i = 0; i < 200; i++) {
      logger.error(`network-failure-${i}-${"x".repeat(80)}`);
    }
    const sizeAfterCap = fs.statSync(logPath).size;
    for (let i = 0; i < 20; i++) {
      logger.error(`post-cap-${i}-${"y".repeat(80)}`);
    }
    const sizeAfterExtraLogs = fs.statSync(logPath).size;

    expect(sizeAfterExtraLogs).toBe(sizeAfterCap);
    expect(sizeAfterCap).toBeLessThanOrEqual(1024 + 512);
    const capWarnings = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .filter((line) => line.includes("log file size cap reached"));
    expect(capWarnings).toHaveLength(1);
  });

  it("creates missing configured log files with 0600 even under a permissive umask", () => {
    if (process.platform === "win32") {
      return;
    }
    process.umask(0);
    setLoggerOverride({ level: "info", file: logPath });

    const logger = getLogger();
    logger.info("create-mode-check");

    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it("tightens a permissively pre-created configured log file to 0600 on first write", () => {
    if (process.platform === "win32") {
      return;
    }
    process.umask(0o002);
    fs.writeFileSync(logPath, "", { encoding: "utf8" });
    fs.chmodSync(logPath, 0o664);
    setLoggerOverride({ level: "info", file: logPath });

    const logger = getLogger();
    logger.info("normalize-mode-check");

    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });
});
