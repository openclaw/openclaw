// Aggregate-budget coverage for the session archive read cache (#193193).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  encodeSessionArchiveContent,
  materializeSessionArchiveForRead,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const CACHE_BUDGET_BYTES = "OPENCLAW_ARCHIVE_CACHE_MAX_BYTES";

let savedBudget: string | undefined;

beforeEach(() => {
  savedBudget = process.env[CACHE_BUDGET_BYTES];
});

afterEach(() => {
  if (savedBudget === undefined) {
    delete process.env[CACHE_BUDGET_BYTES];
  } else {
    process.env[CACHE_BUDGET_BYTES] = savedBudget;
  }
});

async function writeArchive(dir: string, name: string, content: string): Promise<string> {
  const encoded = encodeSessionArchiveContent(content);
  expect(encoded.suffix).toBe(SESSION_ARCHIVE_ZSTD_SUFFIX);
  const archivePath = path.join(dir, `${name}.jsonl${encoded.suffix}`);
  fs.writeFileSync(archivePath, encoded.bytes);
  return archivePath;
}

function cacheDirSize(): number {
  const cacheDir = path.join(fs.realpathSync("/tmp"), "openclaw", "session-archive-read-cache");
  return fs
    .readdirSync(cacheDir)
    .filter((name) => name.endsWith(".jsonl"))
    .reduce((total, name) => total + fs.statSync(path.join(cacheDir, name)).size, 0);
}

describe("materialized archive cache aggregate budget", () => {
  it("evicts least-recently-materialized entries once total cache bytes exceed the budget", async () => {
    // 4 archives x ~1 MiB plaintext each with a 2 MiB budget: reading all
    // four must evict the oldest so the cache never exceeds the budget,
    // and the newest reads must still be served from their cache paths.
    process.env[CACHE_BUDGET_BYTES] = String(2 * 1024 * 1024);
    const dir = tempDirs.make("openclaw-archive-budget-");
    const plaintext = `${JSON.stringify({ type: "message", body: "x".repeat(1024 * 1024) })}\n`;
    const archives: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      archives.push(await writeArchive(dir, `budget-${index}`, plaintext));
    }
    const cachePaths: string[] = [];
    for (const archive of archives) {
      cachePaths.push(await materializeSessionArchiveForRead(archive));
    }
    // Budget: total retained bytes must stay within the configured ceiling.
    expect(cacheDirSize()).toBeLessThanOrEqual(2 * 1024 * 1024);
    // LRU: the oldest materializations were evicted; the newest survive.
    expect(fs.existsSync(cachePaths[0]!)).toBe(false);
    expect(fs.existsSync(cachePaths[1]!)).toBe(false);
    expect(fs.existsSync(cachePaths[3]!)).toBe(true);
    // Re-reading an evicted archive still works (source identity survives eviction).
    const rebuilt = await materializeSessionArchiveForRead(archives[0]!);
    expect(fs.readFileSync(rebuilt, "utf8")).toBe(plaintext);
  }, 120_000);
});
