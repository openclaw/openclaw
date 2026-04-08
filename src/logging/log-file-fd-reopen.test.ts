import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-log-fd-reopen-");

describe("fd reopen after external file replacement", () => {
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
      fs.rmSync(`${logPath}.1`, { force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it("reopens the fd immediately when the log file is unlinked (nlink drops to 0)", () => {
    // No fake timers needed: nlink=0 is detected on every write via fstatSync,
    // bypassing the rename+replace interval gate entirely.
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 1024 * 1024 });
    const logger = getLogger();

    logger.error("before-deletion");
    expect(fs.existsSync(logPath)).toBe(true);

    fs.rmSync(logPath, { force: true });
    expect(fs.existsSync(logPath)).toBe(false);

    logger.error("after-deletion-sentinel");

    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("after-deletion-sentinel");
    // Pre-deletion entry went to the old (now-unlinked) inode, not the new file.
    expect(content).not.toContain("before-deletion");
  });

  it("reopens the fd after rename+replace rotation once the inode-check interval elapses", () => {
    vi.useFakeTimers();

    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 1024 * 1024 });
    const logger = getLogger();

    // First write: seeds lastInodeCheckMs so the interval gate is active.
    logger.error("before-rotation");
    expect(fs.existsSync(logPath)).toBe(true);

    // Simulate logrotate: rename the active file and create a fresh one at the same path.
    fs.renameSync(logPath, `${logPath}.1`);
    fs.writeFileSync(logPath, ""); // new file — different inode, nlink=1

    // Within the 5 s window the throttled path-stat check is suppressed.
    vi.advanceTimersByTime(4_000);
    logger.error("within-window"); // still goes to old inode via fd

    // Advance past the interval; the next write must detect the inode mismatch.
    vi.advanceTimersByTime(2_000); // total 6 s elapsed
    logger.error("after-rotation-sentinel");

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("after-rotation-sentinel");
    expect(content).not.toContain("before-rotation");
    expect(content).not.toContain("within-window");
  });
});
