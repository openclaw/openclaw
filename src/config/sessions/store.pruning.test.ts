import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "./types.js";
import { capEntryCount, pruneStaleEntries, rotateSessionFile } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let fixtureRoot = "";
let fixtureCount = 0;

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pruning-suite-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Unit tests — each function called with explicit override parameters.
// No config loading needed; overrides bypass resolveMaintenanceConfig().
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
  it("removes entries older than maxAgeDays", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["fresh", makeEntry(now - 1 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store.fresh).toBeDefined();
  });

  it("keeps entries newer than maxAgeDays", () => {
    const now = Date.now();
    const store = makeStore([
      ["a", makeEntry(now - 1 * DAY_MS)],
      ["b", makeEntry(now - 6 * DAY_MS)],
      ["c", makeEntry(now)],
    ]);

    const pruned = pruneStaleEntries(store, 7 * DAY_MS);

    expect(pruned).toBe(0);
    expect(Object.keys(store)).toHaveLength(3);
  });

  it("keeps entries with no updatedAt", () => {
    const store: Record<string, SessionEntry> = {
      noDate: { sessionId: crypto.randomUUID() } as SessionEntry,
      fresh: makeEntry(Date.now()),
    };

    const pruned = pruneStaleEntries(store, 1 * DAY_MS);

    expect(pruned).toBe(0);
    expect(store.noDate).toBeDefined();
  });

  it("all entries stale results in empty store", () => {
    const now = Date.now();
    const store = makeStore([
      ["a", makeEntry(now - 10 * DAY_MS)],
      ["b", makeEntry(now - 20 * DAY_MS)],
      ["c", makeEntry(now - 100 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 5 * DAY_MS);

    expect(pruned).toBe(3);
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("falls back to built-in default (30 days) when no override given", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["fresh", makeEntry(now - 29 * DAY_MS)],
    ]);

    // loadConfig mock returns {} → maintenance is undefined → default 30 days
    const pruned = pruneStaleEntries(store);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store.fresh).toBeDefined();
  });
});

describe("capEntryCount", () => {
  it("over limit: keeps N most recent by updatedAt, deletes rest", () => {
    const now = Date.now();
    const store = makeStore([
      ["oldest", makeEntry(now - 4 * DAY_MS)],
      ["old", makeEntry(now - 3 * DAY_MS)],
      ["mid", makeEntry(now - 2 * DAY_MS)],
      ["recent", makeEntry(now - 1 * DAY_MS)],
      ["newest", makeEntry(now)],
    ]);

    const evicted = capEntryCount(store, 3);

    expect(evicted).toBe(2);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store.newest).toBeDefined();
    expect(store.recent).toBeDefined();
    expect(store.mid).toBeDefined();
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });

  it("under limit: no-op", () => {
    const store = makeStore([
      ["a", makeEntry(Date.now())],
      ["b", makeEntry(Date.now() - DAY_MS)],
    ]);

    const evicted = capEntryCount(store, 10);

    expect(evicted).toBe(0);
    expect(Object.keys(store)).toHaveLength(2);
  });

  it("entries without updatedAt are evicted first (lowest priority)", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      noDate1: { sessionId: crypto.randomUUID() } as SessionEntry,
      noDate2: { sessionId: crypto.randomUUID() } as SessionEntry,
      recent: makeEntry(now),
      older: makeEntry(now - DAY_MS),
    };

    const evicted = capEntryCount(store, 2);

    expect(evicted).toBe(2);
    expect(store.recent).toBeDefined();
    expect(store.older).toBeDefined();
    expect(store.noDate1).toBeUndefined();
    expect(store.noDate2).toBeUndefined();
  });

  it("falls back to built-in default (500) when no override given", () => {
    const now = Date.now();
    const entries: Array<[string, SessionEntry]> = [];
    for (let i = 0; i < 501; i++) {
      entries.push([`key-${i}`, makeEntry(now - i * 1000)]);
    }
    const store = makeStore(entries);

    // loadConfig mock returns {} → maintenance is undefined → default 500
    const evicted = capEntryCount(store);

    expect(evicted).toBe(1);
    expect(Object.keys(store)).toHaveLength(500);
    expect(store["key-0"]).toBeDefined();
    expect(store["key-500"]).toBeUndefined();
  });
});

describe("rotateSessionFile", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("rotate");
    storePath = path.join(testDir, "sessions.json");
  });

  it("file under maxBytes: no rotation (returns false)", async () => {
    await fs.writeFile(storePath, "x".repeat(500), "utf-8");

    const rotated = await rotateSessionFile(storePath, 1000);

    expect(rotated).toBe(false);
    const content = await fs.readFile(storePath, "utf-8");
    expect(content).toBe("x".repeat(500));
  });

  it("file over maxBytes: renamed to .bak.{timestamp}, returns true", async () => {
    const bigContent = "x".repeat(200);
    await fs.writeFile(storePath, bigContent, "utf-8");

    const rotated = await rotateSessionFile(storePath, 100);

    expect(rotated).toBe(true);
    await expect(fs.stat(storePath)).rejects.toThrow();
    const files = await fs.readdir(testDir);
    const bakFiles = files.filter((f) => f.startsWith("sessions.json.bak."));
    expect(bakFiles).toHaveLength(1);
    const bakContent = await fs.readFile(path.join(testDir, bakFiles[0]), "utf-8");
    expect(bakContent).toBe(bigContent);
  });

  it("multiple rotations: only keeps 3 most recent .bak files", async () => {
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 5));
    try {
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(storePath, `data-${i}-${"x".repeat(100)}`, "utf-8");
        await rotateSessionFile(storePath, 50);
      }
    } finally {
      nowSpy.mockRestore();
    }

    const files = await fs.readdir(testDir);
    const bakFiles = files.filter((f) => f.startsWith("sessions.json.bak.")).toSorted();

    expect(bakFiles.length).toBeLessThanOrEqual(3);
  });

  it("non-existent file: no rotation (returns false)", async () => {
    const missingPath = path.join(testDir, "missing.json");

    const rotated = await rotateSessionFile(missingPath, 100);

    expect(rotated).toBe(false);
  });

  it("backup file name includes a timestamp", async () => {
    await fs.writeFile(storePath, "x".repeat(100), "utf-8");
    const before = Date.now();

    await rotateSessionFile(storePath, 50);

    const after = Date.now();
    const files = await fs.readdir(testDir);
    const bakFiles = files.filter((f) => f.startsWith("sessions.json.bak."));
    expect(bakFiles).toHaveLength(1);
    const timestamp = Number(bakFiles[0].replace("sessions.json.bak.", ""));
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});
