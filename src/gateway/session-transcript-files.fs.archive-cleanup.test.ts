import fs from "node:fs";
// Gateway tests cover archived-transcript retention cleanup: every retention
// rule shares one directory listing per cleanup call. Store maintenance runs
// this on each save, so per-rule listings would multiply READDIR load.
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupArchivedSessionTranscripts } from "./session-transcript-files.fs.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-06-02T00:00:00.000Z");
const OLD_STAMP = "2026-01-01T00-00-00.000Z";
const FRESH_STAMP = "2026-06-01T00-00-00.000Z";
// First line of a real OpenClaw trajectory runtime file; cleanup of the shared
// OPENCLAW_TRAJECTORY_DIR override only prunes archives that carry this header.
const TRAJECTORY_HEADER = `${JSON.stringify({
  traceSchema: "openclaw-trajectory",
  schemaVersion: 1,
  source: "runtime",
})}\n`;

describe("cleanupArchivedSessionTranscripts", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-archive-cleanup-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  async function seed(names: string[]): Promise<void> {
    for (const name of names) {
      await fsPromises.writeFile(path.join(dir, name), "");
    }
  }

  async function remaining(): Promise<string[]> {
    return (await fsPromises.readdir(dir)).toSorted();
  }

  it("applies every retention rule from a single directory listing", async () => {
    await seed([
      `a.jsonl.deleted.${OLD_STAMP}`,
      `b.jsonl.reset.${OLD_STAMP}`,
      `c.jsonl.reset.${FRESH_STAMP}`,
      "live.jsonl",
    ]);
    const readdirSpy = vi.spyOn(fsPromises, "readdir");

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [
        { reason: "deleted", olderThanMs: 30 * DAY_MS },
        { reason: "reset", olderThanMs: 30 * DAY_MS },
      ],
      nowMs: NOW_MS,
    });

    expect(readdirSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ removed: 2, scanned: 3 });
    expect(await remaining()).toEqual([`c.jsonl.reset.${FRESH_STAMP}`, "live.jsonl"]);
  });

  it("applies each rule's age threshold independently", async () => {
    await seed([`a.jsonl.deleted.${OLD_STAMP}`, `b.jsonl.reset.${OLD_STAMP}`]);

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [
        { reason: "deleted", olderThanMs: 30 * DAY_MS },
        { reason: "reset", olderThanMs: 365 * DAY_MS },
      ],
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ removed: 1, scanned: 2 });
    expect(await remaining()).toEqual([`b.jsonl.reset.${OLD_STAMP}`]);
  });

  it("keeps archives whose reason has no rule", async () => {
    await seed([`a.jsonl.reset.${OLD_STAMP}`]);

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [{ reason: "deleted", olderThanMs: 0 }],
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ removed: 0, scanned: 0 });
    expect(await remaining()).toEqual([`a.jsonl.reset.${OLD_STAMP}`]);
  });

  it("drops invalid rules and never lists when none remain", async () => {
    const readdirSpy = vi.spyOn(fsPromises, "readdir");

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [
        { reason: "deleted", olderThanMs: Number.NaN },
        { reason: "reset", olderThanMs: -1 },
      ],
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ removed: 0, scanned: 0 });
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it("prunes reset trajectory archives under OPENCLAW_TRAJECTORY_DIR (#90707)", async () => {
    const trajectoryDir = path.join(dir, "trajectory-override");
    fs.mkdirSync(trajectoryDir, { recursive: true });
    const previous = process.env.OPENCLAW_TRAJECTORY_DIR;
    try {
      process.env.OPENCLAW_TRAJECTORY_DIR = trajectoryDir;
      await fsPromises.writeFile(
        path.join(trajectoryDir, `session.jsonl.reset.${OLD_STAMP}`),
        TRAJECTORY_HEADER,
      );
      await fsPromises.writeFile(
        path.join(trajectoryDir, `session.jsonl.reset.${FRESH_STAMP}`),
        TRAJECTORY_HEADER,
      );

      const result = await cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [{ reason: "reset", olderThanMs: 30 * DAY_MS }],
        nowMs: NOW_MS,
      });

      expect(result.scanned).toBe(2);
      expect(result.removed).toBe(1);
      const trajectoryEntries = await fsPromises.readdir(trajectoryDir);
      expect(trajectoryEntries).toEqual([`session.jsonl.reset.${FRESH_STAMP}`]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TRAJECTORY_DIR;
      } else {
        process.env.OPENCLAW_TRAJECTORY_DIR = previous;
      }
      fs.rmSync(trajectoryDir, { recursive: true, force: true });
    }
  });

  it("never removes unrelated archive-looking files from a shared OPENCLAW_TRAJECTORY_DIR (#90707)", async () => {
    const trajectoryDir = path.join(dir, "trajectory-shared");
    fs.mkdirSync(trajectoryDir, { recursive: true });
    const previous = process.env.OPENCLAW_TRAJECTORY_DIR;
    try {
      process.env.OPENCLAW_TRAJECTORY_DIR = trajectoryDir;
      // An OpenClaw-owned trajectory archive: carries the runtime header.
      await fsPromises.writeFile(
        path.join(trajectoryDir, `session.jsonl.reset.${OLD_STAMP}`),
        TRAJECTORY_HEADER,
      );
      // Unrelated files that merely look like archives — operator data we must
      // not touch (no trajectory header).
      await fsPromises.writeFile(
        path.join(trajectoryDir, `not-ours.jsonl.reset.${OLD_STAMP}`),
        "some other tool's data\n",
      );
      await fsPromises.writeFile(path.join(trajectoryDir, `backup.jsonl.deleted.${OLD_STAMP}`), "");

      const result = await cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [
          { reason: "reset", olderThanMs: 30 * DAY_MS },
          { reason: "deleted", olderThanMs: 30 * DAY_MS },
        ],
        nowMs: NOW_MS,
      });

      expect(result.removed).toBe(1);
      const trajectoryEntries = (await fsPromises.readdir(trajectoryDir)).toSorted();
      expect(trajectoryEntries).toEqual([
        `backup.jsonl.deleted.${OLD_STAMP}`,
        `not-ours.jsonl.reset.${OLD_STAMP}`,
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TRAJECTORY_DIR;
      } else {
        process.env.OPENCLAW_TRAJECTORY_DIR = previous;
      }
      fs.rmSync(trajectoryDir, { recursive: true, force: true });
    }
  });
});
