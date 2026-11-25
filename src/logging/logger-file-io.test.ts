import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareFileLogTarget } from "./logger-file-io.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const dirs: string[] = [];

function datedFile(dir: string, day: string, ageDays: number): string {
  const file = path.join(dir, `openclaw-${day}.log`);
  fs.writeFileSync(file, "{}\n");
  const time = (NOW - ageDays * DAY_MS) / 1000;
  fs.utimesSync(file, time, time);
  return file;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("rolling log retention", () => {
  it("defaults to 24 hours", () => {
    vi.setSystemTime(NOW);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-retention-"));
    dirs.push(dir);
    const recent = datedFile(dir, "2026-11-24", 0.5);
    datedFile(dir, "2026-11-23", 1.5);

    prepareFileLogTarget(recent, true);

    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(path.join(dir, "openclaw-2026-11-23.log"))).toBe(false);
  });

  it("uses the configured retention lifetime", () => {
    vi.setSystemTime(NOW);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-retention-"));
    dirs.push(dir);
    const recent = datedFile(dir, "2026-11-24", 0.5);
    datedFile(dir, "2026-11-23", 1.5);
    datedFile(dir, "2026-11-22", 2.5);
    datedFile(dir, "2026-11-21", 3.5);

    prepareFileLogTarget(recent, true, 3 * DAY_MS);

    expect(fs.existsSync(path.join(dir, "openclaw-2026-11-23.log"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "openclaw-2026-11-22.log"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "openclaw-2026-11-21.log"))).toBe(false);

    datedFile(dir, "2026-11-21", 3.5);
    prepareFileLogTarget(recent, true, 30 * DAY_MS);
    expect(fs.existsSync(path.join(dir, "openclaw-2026-11-21.log"))).toBe(true);
  });
});
