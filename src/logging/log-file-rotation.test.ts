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
});
