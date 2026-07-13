// Log file failure tests cover exact configured paths and one warning per failed-write episode.
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

const logPathTracker = createSuiteLogPathTracker("openclaw-log-fail-");

describe("logging.file write failures", () => {
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
    fs.rmSync(logPath, { recursive: true, force: true });
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it("writes to the exact configured path when it contains spaces", () => {
    logPath = path.join(path.dirname(logPath), `openclaw log ${path.basename(logPath)}.log`);
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 1024 * 1024 });

    expect(getResolvedLoggerSettings().file).toBe(logPath);
    getLogger().info("exact-path-marker");

    expect(fs.readFileSync(logPath, "utf8")).toContain("exact-path-marker");
  });

  it("warns once per failure episode and resets only after a successful append", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    fs.mkdirSync(logPath, { recursive: true });
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 1024 * 1024 });
    const logger = getLogger();

    logger.error("failed-write-1");
    logger.error("failed-write-2");
    const getWriteFailureWarnings = () =>
      stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("log file write failed"));
    expect(getWriteFailureWarnings()).toHaveLength(1);

    fs.rmSync(logPath, { recursive: true, force: true });
    logger.info("successful-write");
    expect(fs.readFileSync(logPath, "utf8")).toContain("successful-write");

    fs.rmSync(logPath, { force: true });
    fs.mkdirSync(logPath);
    logger.error("failed-write-after-recovery");
    expect(getWriteFailureWarnings()).toHaveLength(2);
  });
});
