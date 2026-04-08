import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-log-fd-reopen-");

describe("fd reopen after external file deletion", () => {
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
    vi.useRealTimers();
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

  it("reopens the fd and writes to the new file when the log path is deleted externally", () => {
    vi.useFakeTimers();

    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 1024 * 1024 });
    const logger = getLogger();

    // First write: establishes the file and triggers the initial inode check
    // (lastInodeCheckMs starts at 0 and Date.now() is far above the 5 s threshold).
    logger.error("before-deletion");
    expect(fs.existsSync(logPath)).toBe(true);

    // Delete the file to simulate tmp cleanup or an external logrotate.
    fs.rmSync(logPath, { force: true });
    expect(fs.existsSync(logPath)).toBe(false);

    // Advance past the 5 s inode-check interval so the next write triggers a reopen.
    vi.advanceTimersByTime(6_000);

    // Write after deletion — the transport should detect the stale fd and reopen.
    logger.error("after-deletion-sentinel");

    // The file must have been recreated and contain the new entry.
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("after-deletion-sentinel");
    // The pre-deletion entry must NOT be in the new file (it went to the old inode).
    expect(content).not.toContain("before-deletion");
  });
});
