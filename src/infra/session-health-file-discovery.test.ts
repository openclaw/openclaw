/**
 * Session Health — File Discovery Tests
 *
 * Tests the shared file-discovery helpers used by both the collector
 * and the executor.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverOrphanedTmpFiles,
  discoverOrphanTranscripts,
  discoverStaleDeletedTranscripts,
  discoverStaleResetTranscripts,
  extractIndexedSessionIds,
  readSessionDirFiles,
} from "./session-health-file-discovery.js";

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-health-discovery-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(name: string, content = "data", ageMs?: number): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, content);
  if (ageMs != null) {
    const mtime = new Date(Date.now() - ageMs);
    await fs.utimes(filePath, mtime, mtime);
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// readSessionDirFiles
// ---------------------------------------------------------------------------

describe("readSessionDirFiles", () => {
  it("returns empty array for non-existent directory", async () => {
    const files = await readSessionDirFiles("/no/such/directory");
    expect(files).toEqual([]);
  });

  it("returns file metadata for files in directory", async () => {
    await writeFile("test.jsonl", "hello world");
    const files = await readSessionDirFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("test.jsonl");
    expect(files[0].size).toBe(11);
    expect(files[0].absolutePath).toBe(path.join(tmpDir, "test.jsonl"));
    expect(typeof files[0].mtimeMs).toBe("number");
  });

  it("ignores directories", async () => {
    await writeFile("test.jsonl");
    await fs.mkdir(path.join(tmpDir, "subdir"));
    const files = await readSessionDirFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("test.jsonl");
  });
});

// ---------------------------------------------------------------------------
// discoverOrphanedTmpFiles
// ---------------------------------------------------------------------------

describe("discoverOrphanedTmpFiles", () => {
  it("returns empty array when no tmp files exist", async () => {
    await writeFile("session-abc.jsonl");
    const files = await discoverOrphanedTmpFiles(tmpDir);
    expect(files).toEqual([]);
  });

  it("discovers .tmp files", async () => {
    await writeFile("session-abc.tmp", "incomplete");
    await writeFile("session-def.tmp", "also incomplete");
    await writeFile("session-ghi.jsonl", "real data");
    const files = await discoverOrphanedTmpFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.name).toSorted()).toEqual(["session-abc.tmp", "session-def.tmp"]);
  });
});

// ---------------------------------------------------------------------------
// discoverOrphanTranscripts
// ---------------------------------------------------------------------------

describe("discoverOrphanTranscripts", () => {
  it("returns empty when all .jsonl files are indexed", async () => {
    await writeFile("session-abc.jsonl");
    await writeFile("session-def.jsonl");
    const indexed = new Set(["session-abc", "session-def"]);
    const files = await discoverOrphanTranscripts(tmpDir, indexed);
    expect(files).toEqual([]);
  });

  it("discovers .jsonl files not in the index", async () => {
    await writeFile("session-abc.jsonl");
    await writeFile("session-def.jsonl");
    await writeFile("session-ghi.jsonl");
    const indexed = new Set(["session-abc"]);
    const files = await discoverOrphanTranscripts(tmpDir, indexed);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.name).toSorted()).toEqual(["session-def.jsonl", "session-ghi.jsonl"]);
  });

  it("ignores non-.jsonl files", async () => {
    await writeFile("session-abc.tmp");
    await writeFile("session-def.deleted.123.jsonl");
    const indexed = new Set<string>();
    const files = await discoverOrphanTranscripts(tmpDir, indexed);
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discoverStaleDeletedTranscripts
// ---------------------------------------------------------------------------

describe("discoverStaleDeletedTranscripts", () => {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * ONE_DAY;

  it("returns empty when no deleted files exist", async () => {
    await writeFile("session-abc.jsonl");
    const files = await discoverStaleDeletedTranscripts(tmpDir, SEVEN_DAYS);
    expect(files).toEqual([]);
  });

  it("discovers .deleted files past retention", async () => {
    // 10 days old — past 7-day retention
    await writeFile("session-abc.deleted.1710000000000.jsonl", "old", 10 * ONE_DAY);
    // 1 day old — within retention
    await writeFile("session-def.deleted.1710800000000.jsonl", "recent", 1 * ONE_DAY);
    const files = await discoverStaleDeletedTranscripts(tmpDir, SEVEN_DAYS);
    expect(files).toHaveLength(1);
    expect(files[0].name).toContain("session-abc.deleted");
  });

  it("returns all deleted files when all are past retention", async () => {
    await writeFile("a.deleted.1.jsonl", "x", 10 * ONE_DAY);
    await writeFile("b.deleted.2.jsonl", "x", 8 * ONE_DAY);
    const files = await discoverStaleDeletedTranscripts(tmpDir, SEVEN_DAYS);
    expect(files).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// discoverStaleResetTranscripts
// ---------------------------------------------------------------------------

describe("discoverStaleResetTranscripts", () => {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * ONE_DAY;

  it("returns empty when no reset files exist", async () => {
    await writeFile("session-abc.jsonl");
    const files = await discoverStaleResetTranscripts(tmpDir, SEVEN_DAYS);
    expect(files).toEqual([]);
  });

  it("discovers .reset files past retention", async () => {
    await writeFile("session-abc.reset.1710000000000.jsonl", "old", 10 * ONE_DAY);
    await writeFile("session-def.reset.1710800000000.jsonl", "recent", 1 * ONE_DAY);
    const files = await discoverStaleResetTranscripts(tmpDir, SEVEN_DAYS);
    expect(files).toHaveLength(1);
    expect(files[0].name).toContain("session-abc.reset");
  });
});

// ---------------------------------------------------------------------------
// extractIndexedSessionIds
// ---------------------------------------------------------------------------

describe("extractIndexedSessionIds", () => {
  it("extracts session IDs from a store", () => {
    const store = {
      "agent:main:key1": { sessionId: "session-abc" },
      "agent:main:key2": { sessionId: "session-def" },
    };
    const ids = extractIndexedSessionIds(store);
    expect(ids).toEqual(new Set(["session-abc", "session-def"]));
  });

  it("ignores entries without sessionId", () => {
    const store = {
      "agent:main:key1": { sessionId: "session-abc" },
      "agent:main:key2": { noSessionId: true },
      "agent:main:key3": null,
    };
    const ids = extractIndexedSessionIds(store as Record<string, unknown>);
    expect(ids).toEqual(new Set(["session-abc"]));
  });

  it("returns empty set for empty store", () => {
    const ids = extractIndexedSessionIds({});
    expect(ids.size).toBe(0);
  });
});
