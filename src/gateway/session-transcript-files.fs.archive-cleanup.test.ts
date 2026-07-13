// Gateway tests cover archived-transcript retention cleanup: every retention
// rule shares one directory listing per cleanup call. Store maintenance runs
// this on each save, so per-rule listings would multiply READDIR load.
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
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

  it("counts stale archives during dry-run without deleting them", async () => {
    await seed([`a.jsonl.deleted.${OLD_STAMP}`, `b.jsonl.reset.${OLD_STAMP}`]);

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [
        { reason: "deleted", olderThanMs: 30 * DAY_MS },
        { reason: "reset", olderThanMs: 30 * DAY_MS },
      ],
      nowMs: NOW_MS,
      dryRun: true,
    });

    expect(result).toEqual({ removed: 2, scanned: 2 });
    expect(await remaining()).toEqual([
      `a.jsonl.deleted.${OLD_STAMP}`,
      `b.jsonl.reset.${OLD_STAMP}`,
    ]);
  });

  it("notifies transcript subscribers only when retention deletes an archive", async () => {
    const archiveName = `a.jsonl.reset.${OLD_STAMP}`;
    const archivePath = path.join(dir, archiveName);
    await seed([archiveName]);
    const updates: string[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
      if (update.sessionFile) {
        updates.push(update.sessionFile);
      }
    });

    try {
      await cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [{ reason: "reset", olderThanMs: 30 * DAY_MS }],
        nowMs: NOW_MS,
        dryRun: true,
      });
      expect(updates).toEqual([]);

      await cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [{ reason: "reset", olderThanMs: 30 * DAY_MS }],
        nowMs: NOW_MS,
      });
      expect(updates).toEqual([archivePath]);
    } finally {
      unsubscribe();
    }
  });

  it("reports only archives deleted successfully", async () => {
    await seed([`a.jsonl.deleted.${OLD_STAMP}`, `b.jsonl.deleted.${OLD_STAMP}`]);
    const onRemoveFile = vi.fn();
    vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(new Error("permission denied"));

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [{ reason: "deleted", olderThanMs: 30 * DAY_MS }],
      nowMs: NOW_MS,
      onRemoveFile,
    });

    expect(result).toEqual({ removed: 1, scanned: 2 });
    expect(onRemoveFile).toHaveBeenCalledTimes(1);
    expect(onRemoveFile.mock.calls[0]?.[0]).toMatch(
      new RegExp(`/b\\.jsonl\\.deleted\\.${OLD_STAMP}$`),
    );
    expect(await remaining()).toEqual([`a.jsonl.deleted.${OLD_STAMP}`]);
  });

  it("skips excluded archive paths during dry-run", async () => {
    await seed([`a.jsonl.deleted.${OLD_STAMP}`, `b.jsonl.reset.${OLD_STAMP}`]);
    const excludedPath = await fsPromises.realpath(path.join(dir, `a.jsonl.deleted.${OLD_STAMP}`));

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [
        { reason: "deleted", olderThanMs: 30 * DAY_MS },
        { reason: "reset", olderThanMs: 30 * DAY_MS },
      ],
      nowMs: NOW_MS,
      dryRun: true,
      excludeCanonicalPaths: new Set([excludedPath]),
    });

    expect(result).toEqual({ removed: 1, scanned: 1 });
    expect(await remaining()).toEqual([
      `a.jsonl.deleted.${OLD_STAMP}`,
      `b.jsonl.reset.${OLD_STAMP}`,
    ]);
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
});
