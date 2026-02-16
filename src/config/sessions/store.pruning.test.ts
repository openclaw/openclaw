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
});

describe("rotateSessionFile", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("rotate");
    storePath = path.join(testDir, "sessions.json");
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
});
