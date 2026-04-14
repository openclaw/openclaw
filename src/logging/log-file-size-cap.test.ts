import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLogger,
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerOverride,
} from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024;
const logPathTracker = createSuiteLogPathTracker("openclaw-log-cap-");

describe("log file size cap", () => {
  let logPath = "";

  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    logPath = logPathTracker.nextPath();
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it("defaults maxFileBytes to 500 MB when unset", () => {
    setLoggerOverride({ level: "info", file: logPath });
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("uses configured maxFileBytes", () => {
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 2048 });
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(2048);
  });

  it("rotates files and continues writing after cap is reached", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true as unknown as ReturnType<typeof process.stderr.write>, // preserve stream contract in test spy
    );
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 1024 });
    const logger = getLogger();

    for (let i = 0; i < 200; i++) {
      logger.error(`network-failure-${i}-${"x".repeat(80)}`);
    }
    const sizeAfterBurst = fs.statSync(logPath).size;
    for (let i = 0; i < 20; i++) {
      logger.error(`post-cap-${i}-${"y".repeat(80)}`);
    }
    const sizeAfterExtraLogs = fs.statSync(logPath).size;

    expect(sizeAfterBurst).toBeGreaterThan(0);
    expect(sizeAfterExtraLogs).toBeGreaterThan(0);
    expect(sizeAfterExtraLogs).toBeLessThanOrEqual(1024 + 512);

    const dir = path.dirname(logPath);
    const base = path.basename(logPath, path.extname(logPath));
    const ext = path.extname(logPath);
    const rotated = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.`) && name.endsWith(ext));
    expect(rotated.length).toBeGreaterThan(0);

    const failureWarnings = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .filter((line) => line.includes("rotation failed") || line.includes("payload exceeds"));
    expect(failureWarnings).toHaveLength(0);
  });
});
