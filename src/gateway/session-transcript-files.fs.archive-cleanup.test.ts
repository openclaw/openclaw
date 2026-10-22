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

  function cleanup(
    rules: Parameters<typeof cleanupArchivedSessionTranscripts>[0]["rules"] = [
      { reason: "deleted", olderThanMs: 0 },
    ],
  ) {
    return cleanupArchivedSessionTranscripts({ directories: [dir], rules, nowMs: NOW_MS });
  }

  it("applies every retention rule from a single directory listing", async () => {
    await seed([
      `a.jsonl.deleted.${OLD_STAMP}`,
      `b.jsonl.reset.${OLD_STAMP}`,
      `c.jsonl.reset.${FRESH_STAMP}`,
      "live.jsonl",
    ]);
    const readdirSpy = vi.spyOn(fsPromises, "readdir");

    await cleanup([
      { reason: "deleted", olderThanMs: 30 * DAY_MS },
      { reason: "reset", olderThanMs: 30 * DAY_MS },
    ]);

    expect(readdirSpy).toHaveBeenCalledTimes(1);
    expect(await remaining()).toEqual([`c.jsonl.reset.${FRESH_STAMP}`, "live.jsonl"]);
  });

  it("drops invalid rules and never lists when none remain", async () => {
    const readdirSpy = vi.spyOn(fsPromises, "readdir");

    await cleanup([
      { reason: "deleted", olderThanMs: Number.NaN },
      { reason: "reset", olderThanMs: -1 },
    ]);

    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])("ignores an archive removed %s stat", async (phase) => {
    const archiveName = `a.jsonl.deleted.${OLD_STAMP}`;
    const archivePath = path.join(dir, archiveName);
    await seed([archiveName]);
    const realStat = fsPromises.stat.bind(fsPromises);
    vi.spyOn(fsPromises, "stat").mockImplementationOnce(async (target) => {
      if (phase === "after") {
        const stat = await realStat(target);
        await fsPromises.rm(target);
        return stat;
      }
      await fsPromises.rm(target);
      return await realStat(target);
    });

    await cleanup();
    await expect(fsPromises.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces archive removal failures without deleting the archive", async () => {
    const archiveName = `a.jsonl.deleted.${OLD_STAMP}`;
    await seed([archiveName]);
    const removeError = Object.assign(new Error("filesystem EACCES"), { code: "EACCES" });
    vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(removeError);

    await expect(cleanup()).rejects.toBe(removeError);
    expect(await remaining()).toEqual([archiveName]);
  });
});
