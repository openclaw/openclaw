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
    const runtimeHeader = JSON.stringify({
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      source: "runtime",
      sessionId: "session",
    });
    try {
      process.env.OPENCLAW_TRAJECTORY_DIR = trajectoryDir;
      await fsPromises.writeFile(
        path.join(trajectoryDir, `session.trajectory.jsonl.reset.${OLD_STAMP}`),
        `${runtimeHeader}\n`,
      );
      await fsPromises.writeFile(
        path.join(trajectoryDir, `session.trajectory.jsonl.reset.${FRESH_STAMP}`),
        `${runtimeHeader}\n`,
      );

      const result = await cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [{ reason: "reset", olderThanMs: 30 * DAY_MS }],
        nowMs: NOW_MS,
      });

      expect(result.scanned).toBe(2);
      expect(result.removed).toBe(1);
      const trajectoryRemaining = await fsPromises.readdir(trajectoryDir);
      expect(trajectoryRemaining).toEqual([`session.trajectory.jsonl.reset.${FRESH_STAMP}`]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TRAJECTORY_DIR;
      } else {
        process.env.OPENCLAW_TRAJECTORY_DIR = previous;
      }
      fs.rmSync(trajectoryDir, { recursive: true, force: true });
    }
  });

  it("preserves unrelated archive-looking files in OPENCLAW_TRAJECTORY_DIR (#94593)", async () => {
    const trajectoryDir = path.join(dir, "trajectory-override");
    fs.mkdirSync(trajectoryDir, { recursive: true });
    const previous = process.env.OPENCLAW_TRAJECTORY_DIR;
    const runtimeHeader = JSON.stringify({
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      source: "runtime",
      sessionId: "session",
    });
    try {
      process.env.OPENCLAW_TRAJECTORY_DIR = trajectoryDir;
      const owned = `session.trajectory.jsonl.reset.${OLD_STAMP}`;
      const unrelated = `backup.jsonl.reset.${OLD_STAMP}`;
      const unrelatedDeleted = `backup.jsonl.deleted.${OLD_STAMP}`;
      await fsPromises.writeFile(path.join(trajectoryDir, owned), `${runtimeHeader}\n`);
      await fsPromises.writeFile(path.join(trajectoryDir, unrelated), "not a trajectory\n");
      await fsPromises.writeFile(path.join(trajectoryDir, unrelatedDeleted), "not a trajectory\n");

      const result = await cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [
          { reason: "reset", olderThanMs: 30 * DAY_MS },
          { reason: "deleted", olderThanMs: 30 * DAY_MS },
        ],
        nowMs: NOW_MS,
      });

      expect(result.removed).toBe(1);
      expect(result.scanned).toBe(3);
      const trajectoryRemaining = (await fsPromises.readdir(trajectoryDir)).toSorted();
      expect(trajectoryRemaining).toEqual([unrelatedDeleted, unrelated]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TRAJECTORY_DIR;
      } else {
        process.env.OPENCLAW_TRAJECTORY_DIR = previous;
      }
      fs.rmSync(trajectoryDir, { recursive: true, force: true });
    }
  });

  it("preserves transcript cleanup when OPENCLAW_TRAJECTORY_DIR overlaps a requested directory (#94593)", async () => {
    const previous = process.env.OPENCLAW_TRAJECTORY_DIR;
    const runtimeHeader = JSON.stringify({
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      source: "runtime",
      sessionId: "session",
    });
    try {
      process.env.OPENCLAW_TRAJECTORY_DIR = dir;
      const transcriptArchive = `session.jsonl.reset.${OLD_STAMP}`;
      const trajectoryArchive = `session.trajectory.jsonl.reset.${OLD_STAMP}`;
      const unrelated = `backup.jsonl.deleted.${OLD_STAMP}`;
      await fsPromises.writeFile(path.join(dir, transcriptArchive), "transcript\n");
      await fsPromises.writeFile(path.join(dir, trajectoryArchive), `${runtimeHeader}\n`);
      await fsPromises.writeFile(path.join(dir, unrelated), "not a trajectory\n");

      const result = await cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [{ reason: "reset", olderThanMs: 30 * DAY_MS }],
        nowMs: NOW_MS,
      });

      expect(result.removed).toBe(2);
      expect(result.scanned).toBe(2);
      expect(await remaining()).toEqual([unrelated]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TRAJECTORY_DIR;
      } else {
        process.env.OPENCLAW_TRAJECTORY_DIR = previous;
      }
    }
  });
});
