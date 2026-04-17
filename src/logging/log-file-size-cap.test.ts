import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLogger,
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerOverride,
} from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { registerLogTransport } from "./logger.js";

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

  it("suppresses file writes after cap is reached and warns once", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
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

  it("redacts secrets before writing file logs and forwarding external transports", () => {
    const records: Array<Record<string, unknown>> = [];
    const unregister = registerLogTransport((record) => {
      records.push(record);
    });
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: logPath });

    try {
      const logger = getLogger();
      logger.error(
        { apiKey: "abcdef1234567890ghij" },
        "Authorization: Bearer abcdef1234567890ghij",
      );
    } finally {
      unregister();
    }

    const fileContents = fs.readFileSync(logPath, "utf8");
    const transportContents = JSON.stringify(records);

    expect(fileContents).toContain("abcdef…ghij");
    expect(fileContents).not.toContain("abcdef1234567890ghij");
    expect(transportContents).toContain("abcdef…ghij");
    expect(transportContents).not.toContain("abcdef1234567890ghij");
  });
});
