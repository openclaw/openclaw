import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evictMaterializedArchiveCacheOverBudget,
  MATERIALIZED_ARCHIVE_CACHE_MAX_ENTRIES,
} from "./archive-cache-budget.js";

const dirs: string[] = [];

function makeCacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-archive-cache-"));
  dirs.push(dir);
  return dir;
}

function writeEntry(dir: string, name: string, size: number, mtimeMs: number): string {
  const entryPath = path.join(dir, name);
  fs.writeFileSync(entryPath, "x".repeat(size));
  const seconds = mtimeMs / 1000;
  fs.utimesSync(entryPath, seconds, seconds);
  return entryPath;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("materialized archive cache budget", () => {
  it("leaves a directory that fits untouched", () => {
    const dir = makeCacheDir();
    const keep = writeEntry(dir, "a.jsonl", 16, 1_000);
    evictMaterializedArchiveCacheOverBudget(dir, { maxBytes: 1024, maxEntries: 8 });
    expect(fs.existsSync(keep)).toBe(true);
  });

  it("evicts the least recently used entry first when bytes exceed the budget", () => {
    const dir = makeCacheDir();
    const oldest = writeEntry(dir, "oldest.jsonl", 64, 1_000);
    const middle = writeEntry(dir, "middle.jsonl", 64, 2_000);
    const newest = writeEntry(dir, "newest.jsonl", 64, 3_000);

    evictMaterializedArchiveCacheOverBudget(dir, { maxBytes: 128, maxEntries: 8 });

    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
  });

  it("evicts by entry count when many small entries stay under the byte budget", () => {
    const dir = makeCacheDir();
    writeEntry(dir, "one.jsonl", 4, 1_000);
    writeEntry(dir, "two.jsonl", 4, 2_000);
    const three = writeEntry(dir, "three.jsonl", 4, 3_000);

    evictMaterializedArchiveCacheOverBudget(dir, { maxBytes: 1024, maxEntries: 1 });

    expect(fs.readdirSync(dir)).toEqual(["three.jsonl"]);
    expect(fs.existsSync(three)).toBe(true);
  });

  it("never evicts an in-flight .tmp writer", () => {
    const dir = makeCacheDir();
    writeEntry(dir, "cached.jsonl", 64, 1_000);
    const temp = writeEntry(dir, "cached.jsonl.123.tmp", 64, 2_000);

    evictMaterializedArchiveCacheOverBudget(dir, { maxBytes: 0, maxEntries: 0 });

    expect(fs.existsSync(temp)).toBe(true);
    expect(fs.existsSync(path.join(dir, "cached.jsonl"))).toBe(false);
  });

  it("is a no-op for a missing directory", () => {
    const dir = path.join(makeCacheDir(), "missing");
    expect(() => evictMaterializedArchiveCacheOverBudget(dir)).not.toThrow();
  });

  it("defaults to the shipped entry cap", () => {
    expect(MATERIALIZED_ARCHIVE_CACHE_MAX_ENTRIES).toBe(64);
  });
});
