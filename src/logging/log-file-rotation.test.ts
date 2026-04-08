import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function rmRollingLogFamily(basePath: string): void {
  for (let n = 0; n < 12; n++) {
    const p = n === 0 ? basePath : `${basePath}.${n}`;
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

describe("rolling log file size rotation", () => {
  let logDir = "";
  let rollingPath = "";

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
    if (rollingPath) {
      rmRollingLogFamily(rollingPath);
    }
    if (logDir) {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      logDir = "";
      rollingPath = "";
    }
  });

  it("renames the active log to .1 when the rolling file crosses the rotation threshold", () => {
    const today = formatLocalDate(new Date());
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-rot-"));
    rollingPath = path.join(logDir, `openclaw-${today}.log`);
    rmRollingLogFamily(rollingPath);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);

    setLoggerOverride({ level: "info", file: rollingPath, maxFileBytes: 4096 });
    const logger = getLogger();

    for (let i = 0; i < 80; i++) {
      logger.error(`rotation-test-${i}-${"z".repeat(120)}`);
    }

    expect(fs.existsSync(`${rollingPath}.1`)).toBe(true);
    const activeSize = fs.statSync(rollingPath).size;
    expect(activeSize).toBeGreaterThan(0);
    expect(activeSize).toBeLessThanOrEqual(4096);

    const capWarnings = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .filter((line) => line.includes("log file size cap reached"));
    expect(capWarnings).toHaveLength(0);

    stderrSpy.mockRestore();
  });

  it("enforces the size cap when renameSync throws (failed rotation)", () => {
    const today = formatLocalDate(new Date());
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-rot-"));
    rollingPath = path.join(logDir, `openclaw-${today}.log`);
    rmRollingLogFamily(rollingPath);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);

    // Block all renames from the start so rotation always fails with EXDEV.
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = Object.assign(new Error("EXDEV: cross-device link not permitted"), {
        code: "EXDEV",
      });
      throw err;
    });

    const maxFileBytes = 2048;
    setLoggerOverride({ level: "info", file: rollingPath, maxFileBytes });
    const logger = getLogger();

    // Send enough entries to exceed maxFileBytes several times over. Under the old bug
    // pendingBytes was reset to 0 on every failed rotation attempt, so the cap was never
    // enforced and the file grew without bound.
    for (let i = 0; i < 40; i++) {
      logger.error(`fail-rot-${i}-${"x".repeat(100)}`);
    }

    stderrSpy.mockRestore();

    // The file must not grow past the hard cap (with a small tolerance for the one
    // entry that may land before the cap-warning gate fires).
    const finalSize = fs.statSync(rollingPath).size;
    expect(finalSize).toBeLessThanOrEqual(maxFileBytes * 1.15);
  });

  it("prunes stale rotated segments after a successful rotation in a long-lived process", () => {
    const today = formatLocalDate(new Date());
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-rot-"));
    rollingPath = path.join(logDir, `openclaw-${today}.log`);
    rmRollingLogFamily(rollingPath);

    setLoggerOverride({ level: "info", file: rollingPath, maxFileBytes: 4096 });
    // buildLogger runs its own prune pass on construction; create the stale file after
    // so only the rotation-triggered prune can remove it.
    const logger = getLogger();

    const staleSegment = `${rollingPath}.1`;
    fs.writeFileSync(staleSegment, "old-segment\n");
    // Back-date mtime by 25 hours so it falls outside the 24h retention window.
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(staleSegment, staleTime, staleTime);

    // Fill the active log past the rotation threshold.
    for (let i = 0; i < 80; i++) {
      logger.error(`prune-test-${i}-${"z".repeat(120)}`);
    }

    // The stale .1 content should be gone. A second rotation may have re-created .1 with
    // fresh content, so check the sentinel string rather than file existence.
    const segment1Content = fs.existsSync(staleSegment)
      ? fs.readFileSync(staleSegment, "utf8")
      : "";
    expect(segment1Content).not.toContain("old-segment");
    // Active log must still be present.
    expect(fs.existsSync(rollingPath)).toBe(true);
  });

  it("does not rotate when a single serialized line exceeds maxFileBytes", () => {
    const today = formatLocalDate(new Date());
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-rot-"));
    rollingPath = path.join(logDir, `openclaw-${today}.log`);
    rmRollingLogFamily(rollingPath);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);

    const maxFileBytes = 256;
    setLoggerOverride({ level: "info", file: rollingPath, maxFileBytes });
    const logger = getLogger();

    const huge = "h".repeat(400);
    for (let i = 0; i < 15; i++) {
      logger.error(`oversize-${i}-${huge}`);
    }

    expect(fs.existsSync(`${rollingPath}.1`)).toBe(false);
    for (let n = 2; n < 12; n++) {
      expect(fs.existsSync(`${rollingPath}.${n}`)).toBe(false);
    }

    stderrSpy.mockRestore();
  });
});
