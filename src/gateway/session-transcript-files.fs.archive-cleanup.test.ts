// Gateway tests cover archived-transcript retention cleanup: every retention
// rule shares one directory listing per cleanup call. Store maintenance runs
// this on each save, so per-rule listings would multiply READDIR load.
import fs from "node:fs";
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

  it("ages out trajectory tombstones under the same rules and directory listing as transcript tombstones", async () => {
    // The trajectory pair is renamed beside its transcript on reset/delete
    // (trajectory/cleanup.ts), so its tombstones share this exact suffix
    // contract and reuse this same sweep with no trajectory-specific code.
    await seed([
      `session-a.jsonl.deleted.${OLD_STAMP}`,
      `session-a.trajectory.jsonl.deleted.${OLD_STAMP}`,
      `session-a.trajectory-path.json.deleted.${OLD_STAMP}`,
      `session-b.jsonl.reset.${FRESH_STAMP}`,
      `session-b.trajectory.jsonl.reset.${FRESH_STAMP}`,
      `session-b.trajectory-path.json.reset.${FRESH_STAMP}`,
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
    expect(result).toEqual({ removed: 3, scanned: 6 });
    expect(await remaining()).toEqual(
      [
        `session-b.jsonl.reset.${FRESH_STAMP}`,
        `session-b.trajectory.jsonl.reset.${FRESH_STAMP}`,
        `session-b.trajectory-path.json.reset.${FRESH_STAMP}`,
      ].toSorted(),
    );
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

describe("cleanupArchivedSessionTranscripts external-directory ownership guard", () => {
  let storeDir = "";
  let externalDir = "";

  beforeEach(async () => {
    storeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-store-"));
    externalDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-ext-traj-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsPromises.rm(storeDir, { recursive: true, force: true });
    await fsPromises.rm(externalDir, { recursive: true, force: true });
  });

  const RULES = [
    { reason: "deleted" as const, olderThanMs: 30 * DAY_MS },
    { reason: "reset" as const, olderThanMs: 30 * DAY_MS },
  ];

  // Matches what the trajectory recorder writes as a runtime sidecar's first
  // JSONL line (src/trajectory/runtime.ts).
  function runtimeSidecar(sessionId: string): string {
    const header = JSON.stringify({
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId: "trace-1",
      source: "runtime",
      type: "session",
      sessionId,
    });
    return `${header}\n${JSON.stringify({ seq: 2, type: "note" })}\n`;
  }

  // Matches the pretty-printed pointer body the recorder writes.
  function pointerBody(sessionId: string): string {
    return `${JSON.stringify(
      {
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId,
        runtimeFile: `/elsewhere/${sessionId}.trajectory.jsonl`,
      },
      null,
      2,
    )}\n`;
  }

  it("in an external dir, reaps a genuine aged trajectory tombstone but keeps a foreign suffix look-alike", async () => {
    // Store dir owns a plain transcript tombstone (no header) — aged by suffix.
    await fsPromises.writeFile(path.join(storeDir, `session-a.jsonl.deleted.${OLD_STAMP}`), "");
    // External (operator-owned) dir: an unrelated rotated log that merely matches
    // the archive suffix must survive; our own aged tombstone beside it must go.
    await fsPromises.writeFile(
      path.join(externalDir, `notes.jsonl.reset.${OLD_STAMP}`),
      "some other tool's rotated log\n",
    );
    await fsPromises.writeFile(
      path.join(externalDir, `session-b.trajectory.jsonl.deleted.${OLD_STAMP}`),
      runtimeSidecar("session-b"),
    );

    const result = await cleanupArchivedSessionTranscripts({
      directories: [storeDir, externalDir],
      storeDir,
      rules: RULES,
      nowMs: NOW_MS,
    });

    expect(await fsPromises.readdir(storeDir)).toEqual([]);
    expect(await fsPromises.readdir(externalDir)).toEqual([`notes.jsonl.reset.${OLD_STAMP}`]);
    expect(result.removed).toBe(2);
  });

  it("keeps a foreign pointer-shaped tombstone with invalid JSON in an external dir", async () => {
    await fsPromises.writeFile(
      path.join(externalDir, `foreign.trajectory-path.json.deleted.${OLD_STAMP}`),
      "not-json {{{ nope\n",
    );
    // A genuine aged pointer beside it is still reaped.
    await fsPromises.writeFile(
      path.join(externalDir, `session-c.trajectory-path.json.deleted.${OLD_STAMP}`),
      pointerBody("session-c"),
    );

    const result = await cleanupArchivedSessionTranscripts({
      directories: [externalDir],
      storeDir,
      rules: RULES,
      nowMs: NOW_MS,
    });

    expect(await fsPromises.readdir(externalDir)).toEqual([
      `foreign.trajectory-path.json.deleted.${OLD_STAMP}`,
    ]);
    expect(result.removed).toBe(1);
  });

  it("still ages in-store-dir tombstones by suffix alone, with no header requirement", async () => {
    // Regression guard on the hot common path: files inside the store dir are
    // ours by construction, so empty/headerless tombstones must still age out
    // even when a storeDir is supplied (no per-file header read there).
    await fsPromises.writeFile(path.join(storeDir, `session-d.jsonl.deleted.${OLD_STAMP}`), "");
    await fsPromises.writeFile(
      path.join(storeDir, `session-d.trajectory.jsonl.deleted.${OLD_STAMP}`),
      "",
    );
    await fsPromises.writeFile(
      path.join(storeDir, `session-d.trajectory-path.json.deleted.${OLD_STAMP}`),
      "",
    );

    const result = await cleanupArchivedSessionTranscripts({
      directories: [storeDir],
      storeDir,
      rules: RULES,
      nowMs: NOW_MS,
    });

    expect(await fsPromises.readdir(storeDir)).toEqual([]);
    expect(result.removed).toBe(3);
  });

  it("keeps an oversized/garbage external tombstone using only a bounded prefix read", async () => {
    const blobName = `blob.jsonl.reset.${OLD_STAMP}`;
    // 256 KiB of non-JSON, single line: a genuine trajectory header would sit on
    // the first line, so this must be kept — and only a bounded prefix may be
    // read, never the whole blob.
    await fsPromises.writeFile(path.join(externalDir, blobName), "x".repeat(256 * 1024));
    const readSyncSpy = vi.spyOn(fs, "readSync");

    const result = await cleanupArchivedSessionTranscripts({
      directories: [externalDir],
      storeDir,
      rules: RULES,
      nowMs: NOW_MS,
    });

    expect(await fsPromises.readdir(externalDir)).toEqual([blobName]);
    expect(result.removed).toBe(0);
    // Proof of bounded read: every read targets a capped buffer, so no more than
    // that many bytes of the 256 KiB blob are ever loaded.
    expect(readSyncSpy).toHaveBeenCalled();
    for (const call of readSyncSpy.mock.calls) {
      const buffer = call[1] as ArrayBufferView;
      expect(buffer.byteLength).toBeLessThanOrEqual(64 * 1024);
    }
  });
});
