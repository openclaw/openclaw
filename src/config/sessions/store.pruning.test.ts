import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { capEntryCount, pruneStaleEntries, rotateSessionFile } from "./store.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const fixtureSuite = createFixtureSuite("openclaw-pruning-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
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
    testDir = await fixtureSuite.createCaseDir("rotate");
    storePath = path.join(testDir, "sessions.json");
  });

  it("file over maxBytes: copied to .bak.{timestamp}, original preserved, returns true", async () => {
    const bigContent = "x".repeat(200);
    await fs.writeFile(storePath, bigContent, "utf-8");

    const rotated = await rotateSessionFile(storePath, 100);

    expect(rotated).toBe(true);
    // Original file must still exist so concurrent readers never see a missing
    // file (issue #18572: rename caused a race window that wiped session memory).
    await expect(fs.stat(storePath)).resolves.toBeTruthy();
    const originalContent = await fs.readFile(storePath, "utf-8");
    expect(originalContent).toBe(bigContent);
    // Backup must also exist with the same content.
    const files = await fs.readdir(testDir);
    const bakFiles = files.filter((f) => f.startsWith("sessions.json.bak."));
    expect(bakFiles).toHaveLength(1);
    const bakContent = await fs.readFile(path.join(testDir, bakFiles[0]), "utf-8");
    expect(bakContent).toBe(bigContent);
  });

  it("race-condition regression: sessions.json readable throughout rotation (issue #18572)", async () => {
    // With the old rename-based approach, sessions.json disappeared between
    // rename and the subsequent atomic write.  Any inbound message processed
    // during that window would find the file missing, fall back to {}, and
    // generate a new sessionId — a "memory wipe".  copyFile keeps the
    // original present so concurrent readers always see valid data.
    const content = JSON.stringify({ "user:123": { sessionId: "sess-abc", updatedAt: Date.now() } });
    await fs.writeFile(storePath, content, "utf-8");

    let contentDuringRotation: string | undefined;
    const realCopyFile = (fs.copyFile as typeof fs.copyFile).bind(fs);
    const spy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
      // Simulate a concurrent reader at the exact moment the backup is written.
      try {
        contentDuringRotation = await fs.readFile(storePath, "utf-8");
      } catch {
        contentDuringRotation = "(missing)";
      }
      return realCopyFile(...(args as Parameters<typeof fs.copyFile>));
    });

    try {
      await rotateSessionFile(storePath, 10);
    } finally {
      spy.mockRestore();
    }

    // Concurrent reader must have seen valid JSON, not a missing/empty file.
    expect(contentDuringRotation).toBe(content);
  });

  it("multiple rotations: only keeps 3 most recent .bak files", async () => {
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 5));
    try {
      // 4 rotations are enough to verify pruning to <=3 backups.
      for (let i = 0; i < 4; i++) {
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
