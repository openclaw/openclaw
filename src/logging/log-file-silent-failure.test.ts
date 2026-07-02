// Log file silent failure tests cover empty paths, whitespace trimming, and
// stderr warnings when file writes fail persistently.
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

describe("logging.file silent failure", () => {
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
      // best-effort cleanup
    }
  });

  it("treats empty logging.file as unset and falls back to default", () => {
    setLoggerOverride({ level: "info", file: "", maxFileBytes: 1024 * 1024 });
    const settings = getResolvedLoggerSettings();
    expect(settings.file).not.toBe("");
    expect(settings.file).toMatch(/\.log$/);
  });

  it("treats whitespace-only logging.file as unset", () => {
    setLoggerOverride({ level: "info", file: "   ", maxFileBytes: 1024 * 1024 });
    expect(getResolvedLoggerSettings().file).not.toBe("   ");
    expect(getResolvedLoggerSettings().file).toMatch(/\.log$/);
  });

  it("preserves exact bytes of a non-empty path (no silent trim)", () => {
    // Non-empty configured paths are kept verbatim; only blank values fall back.
    setLoggerOverride({ level: "info", file: `${logPath}  `, maxFileBytes: 1024 * 1024 });
    expect(getResolvedLoggerSettings().file).toBe(`${logPath}  `);
  });

  it("preserves leading whitespace in a non-empty path", () => {
    setLoggerOverride({ level: "info", file: `  ${logPath}`, maxFileBytes: 1024 * 1024 });
    expect(getResolvedLoggerSettings().file).toBe(`  ${logPath}`);
  });

  it("emits stderr warning when file writes fail persistently", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    // Create a read-only directory so that mkdirSync passes but appendFileSync fails.
    const readonlyDir = logPathTracker.nextPath();
    fs.mkdirSync(readonlyDir, { recursive: true });
    const badPath = path.join(readonlyDir, "openclaw.log");
    try {
      fs.chmodSync(readonlyDir, 0o555);
      setLoggerOverride({ level: "info", file: badPath, maxFileBytes: 1024 * 1024 });
      const logger = getLogger();
      logger.error("trigger");
      logger.error("trigger-2");

      const warnings = stderrSpy.mock.calls
        .map(([c]) => String(c))
        .filter((s) => s.includes("log file write failed"));
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      try {
        fs.chmodSync(readonlyDir, 0o755);
      } catch {
        // best effort
      }
      fs.rmSync(readonlyDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });
});
