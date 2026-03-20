import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";

function makeLogPath(): string {
  return path.join(os.tmpdir(), `openclaw-rotation-${crypto.randomUUID()}.log`);
}

function cleanup(...files: string[]) {
  for (const f of files) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // ignore
    }
  }
}

describe("log rotation", () => {
  let logPath = "";

  beforeEach(() => {
    logPath = makeLogPath();
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    // Clean up the primary log and up to 10 rotated backups
    cleanup(logPath, ...Array.from({ length: 10 }, (_, i) => `${logPath}.${i + 1}`));
  });

  it("rotates the log file when size cap is exceeded", () => {
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 512, maxBackups: 3 });
    const logger = getLogger();

    // Write enough to trigger at least one rotation
    for (let i = 0; i < 100; i++) {
      logger.info(`rotation-test-${i}-${"a".repeat(60)}`);
    }

    // The primary log file should exist and be within cap
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(512 + 512);

    // At least one backup should exist
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
  });

  it("archives rotated files with numbered suffixes", () => {
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 256, maxBackups: 3 });
    const logger = getLogger();

    // Force multiple rotations
    for (let i = 0; i < 200; i++) {
      logger.info(`archive-test-${i}-${"b".repeat(60)}`);
    }

    // Primary log should exist
    expect(fs.existsSync(logPath)).toBe(true);
    // At least one backup should exist
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
  });

  it("enforces retention: does not keep more than maxBackups rotated files", () => {
    const maxBackups = 3;
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 128, maxBackups });
    const logger = getLogger();

    // Write a lot to force many rotations
    for (let i = 0; i < 500; i++) {
      logger.info(`retention-test-${i}-${"c".repeat(50)}`);
    }

    // Backup beyond maxBackups should not exist
    expect(fs.existsSync(`${logPath}.${maxBackups + 1}`)).toBe(false);
  });

  it("preserves JSON format in the primary log after rotation", () => {
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 256, maxBackups: 2 });
    const logger = getLogger();

    for (let i = 0; i < 50; i++) {
      logger.info(`json-format-test-${i}`);
    }

    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("preserves JSON format in rotated backup files", () => {
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 256, maxBackups: 2 });
    const logger = getLogger();

    for (let i = 0; i < 100; i++) {
      logger.info(`json-backup-test-${i}-${"d".repeat(40)}`);
    }

    const backup = `${logPath}.1`;
    if (fs.existsSync(backup)) {
      const content = fs.readFileSync(backup, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("no data is lost during rotation: all lines in retained files are parseable", () => {
    const maxBackups = 3;
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 256, maxBackups });
    const logger = getLogger();

    for (let i = 0; i < 80; i++) {
      logger.info(`no-loss-test-${i}-${"e".repeat(30)}`);
    }

    // Every line in every retained file must be valid JSON (no partial/corrupt writes)
    const files = [logPath, `${logPath}.1`, `${logPath}.2`, `${logPath}.3`].filter((f) =>
      fs.existsSync(f),
    );
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const content = fs.readFileSync(f, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("rotation disabled (maxBackups=0) suppresses writes at cap like before", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 512, maxBackups: 0 });
    const logger = getLogger();

    for (let i = 0; i < 200; i++) {
      logger.error(`suppress-test-${i}-${"f".repeat(60)}`);
    }

    const sizeAfterCap = fs.statSync(logPath).size;
    // No backup file should be created
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    // Size should be bounded near cap
    expect(sizeAfterCap).toBeLessThanOrEqual(512 + 512);

    const capWarnings = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .filter((line) => line.includes("log file size cap reached"));
    expect(capWarnings).toHaveLength(1);

    stderrSpy.mockRestore();
  });
});
