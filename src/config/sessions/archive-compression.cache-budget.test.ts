// Aggregate-budget coverage for the session archive read cache (#193193).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type {
  encodeSessionArchiveContent as EncodeSessionArchiveContent,
  materializeSessionArchiveForRead as MaterializeSessionArchiveForRead,
} from "./archive-compression.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const CACHE_BUDGET_BYTES = "OPENCLAW_ARCHIVE_CACHE_MAX_BYTES";

let savedBudget: string | undefined;
let encodeSessionArchiveContent: typeof EncodeSessionArchiveContent;
let materializeSessionArchiveForRead: typeof MaterializeSessionArchiveForRead;
let SESSION_ARCHIVE_ZSTD_SUFFIX: ".jsonl.zst" | string;

beforeEach(async () => {
  savedBudget = process.env[CACHE_BUDGET_BYTES];
  // The TTL sweep is rate limited by module state, so every case reloads the
  // module to start from a clean sweep clock instead of inheriting a peer's.
  vi.resetModules();
  const module = await import("./archive-compression.js");
  encodeSessionArchiveContent = module.encodeSessionArchiveContent;
  materializeSessionArchiveForRead = module.materializeSessionArchiveForRead;
  SESSION_ARCHIVE_ZSTD_SUFFIX = module.SESSION_ARCHIVE_ZSTD_SUFFIX;
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

  it("keeps a materialized archive readable when it alone exceeds the budget", async () => {
    // A single archive larger than the whole budget must not be evicted by the
    // sweep it triggers: the returned path has to exist and hold its bytes.
    process.env[CACHE_BUDGET_BYTES] = String(64 * 1024);
    const dir = tempDirs.make("openclaw-archive-oversize-");
    const plaintext = `${JSON.stringify({ type: "message", body: "y".repeat(256 * 1024) })}\n`;
    const archive = await writeArchive(dir, "oversize", plaintext);

    const cachePath = await materializeSessionArchiveForRead(archive);

    expect(fs.existsSync(cachePath)).toBe(true);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(plaintext);
    // The second read is a cache hit and must stay readable for the same reason.
    expect(await materializeSessionArchiveForRead(archive)).toBe(cachePath);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(plaintext);
  }, 120_000);

  it("expires aged entries while still serving the archive being read", async () => {
    // The TTL sweep used to run only on the write path, so a warm cache whose
    // archives stopped changing kept plaintext alive past its expiry.
    process.env[CACHE_BUDGET_BYTES] = String(8 * 1024 * 1024);
    const dir = tempDirs.make("openclaw-archive-ttl-");
    // Fill an unrelated stale entry first so the cache directory exists and the
    // second read below is a pure hit on an aged directory.
    const aged = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const cacheDir = path.join(fs.realpathSync("/tmp"), "openclaw", "session-archive-read-cache");
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const expiring = path.join(cacheDir, `${"f".repeat(32)}-expired-${process.pid}.jsonl`);
    fs.writeFileSync(expiring, "stale");
    fs.utimesSync(expiring, aged, aged);

    const plaintext = `${JSON.stringify({ type: "message", body: "z".repeat(64 * 1024) })}\n`;
    const archive = await writeArchive(dir, "aged", plaintext);
    const cachePath = await materializeSessionArchiveForRead(archive);
    expect(fs.existsSync(cachePath)).toBe(true);

    // Age the whole cache directory past the 24h TTL, then read the same
    // archive again: identity still matches, so this is a pure hit path.
    for (const name of fs.readdirSync(cacheDir)) {
      const entry = path.join(cacheDir, name);
      fs.utimesSync(entry, aged, aged);
    }

    const served = await materializeSessionArchiveForRead(archive);

    // Unrelated aged entries are reclaimed...
    expect(fs.existsSync(expiring)).toBe(false);
    // ...and the caller still gets readable bytes for the archive it asked for.
    expect(fs.readFileSync(served, "utf8")).toBe(plaintext);
  }, 120_000);
});
