// Aggregate-budget coverage for the session archive read cache (#193193).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

// The budget is a fixed production constant, so tests swap it through the module
// mock instead of an env knob the repo would have to budget an OPENCLAW_* slot for.
let budgetBytes = 256 * 1024 * 1024;
vi.mock("./archive-cache-budget.js", () => ({
  get materializedArchiveCacheBudgetBytes() {
    return budgetBytes;
  },
}));

// Give this suite its own cache root: the shared /tmp directory is also used by
// the non-budget suite, and parallel files would otherwise evict each other's
// entries mid-assertion.
let cacheRoot = "";
vi.mock("../../infra/tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: () => cacheRoot,
}));

type ArchiveModule = typeof import("./archive-compression.js");
let archive: ArchiveModule;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(async () => {
  cacheRoot = tempDirs.make("openclaw-archive-cache-root-");
  // The TTL sweep is rate limited by module state; reload so every case starts
  // from a clean sweep clock instead of inheriting the previous case's.
  vi.resetModules();
  archive = await import("./archive-compression.js");
});

function writeArchive(dir: string, name: string, content: string): string {
  const encoded = archive.encodeSessionArchiveContent(content);
  expect(encoded.suffix).toBe(archive.SESSION_ARCHIVE_ZSTD_SUFFIX);
  const archivePath = path.join(dir, `${name}.jsonl${encoded.suffix}`);
  fs.writeFileSync(archivePath, encoded.bytes);
  return archivePath;
}

const cacheDir = () => path.join(cacheRoot, "session-archive-read-cache");

const cacheDirSize = () =>
  fs
    .readdirSync(cacheDir())
    .filter((name) => name.endsWith(".jsonl"))
    .reduce((total, name) => total + fs.statSync(path.join(cacheDir(), name)).size, 0);

const body = (fill: string, bytes: number) =>
  `${JSON.stringify({ type: "message", body: fill.repeat(bytes) })}\n`;

describe("materialized archive cache aggregate budget", () => {
  it("evicts least-recently-materialized entries once total cache bytes exceed the budget", async () => {
    // 4 x ~1 MiB with a 2 MiB budget: reading all four must evict the oldest, and
    // the newest must still be served from its own cache path.
    budgetBytes = 2 * 1024 * 1024;
    const dir = tempDirs.make("openclaw-archive-budget-");
    const plaintext = body("x", 1024 * 1024);
    const archives = [0, 1, 2, 3].map((i) => writeArchive(dir, `budget-${i}`, plaintext));
    const cachePaths: string[] = [];
    for (const file of archives) {
      cachePaths.push(await archive.materializeSessionArchiveForRead(file));
    }
    expect(cacheDirSize()).toBeLessThanOrEqual(budgetBytes);
    expect(cachePaths.slice(0, 2).map((p) => fs.existsSync(p))).toEqual([false, false]);
    expect(fs.existsSync(cachePaths[3]!)).toBe(true);
    // An evicted archive still reads correctly: identity, not presence, gates a hit.
    expect(
      fs.readFileSync(await archive.materializeSessionArchiveForRead(archives[0]!), "utf8"),
    ).toBe(plaintext);
  }, 120_000);

  it("keeps a materialized archive readable when it alone exceeds the budget", async () => {
    // The sweep must never delete the entry this call is about to hand back.
    budgetBytes = 64 * 1024;
    const dir = tempDirs.make("openclaw-archive-oversize-");
    const plaintext = body("y", 256 * 1024);
    const file = writeArchive(dir, "oversize", plaintext);
    const cachePath = await archive.materializeSessionArchiveForRead(file);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(plaintext);
    // The second call is a hit and must stay readable for the same reason.
    expect(await archive.materializeSessionArchiveForRead(file)).toBe(cachePath);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(plaintext);
  }, 120_000);

  it("expires aged entries while still serving the archive being read", async () => {
    // The TTL sweep used to run only on the write path, so a warm cache kept
    // plaintext past its expiry whenever reads kept hitting it.
    budgetBytes = 8 * 1024 * 1024;
    const dir = tempDirs.make("openclaw-archive-ttl-");
    const aged = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    const stale = path.join(cacheDir(), `${"f".repeat(32)}-expired-${process.pid}.jsonl`);
    fs.writeFileSync(stale, "stale");
    fs.utimesSync(stale, aged, aged);

    const plaintext = body("z", 64 * 1024);
    const file = writeArchive(dir, "aged", plaintext);
    await archive.materializeSessionArchiveForRead(file);
    for (const name of fs.readdirSync(cacheDir())) {
      fs.utimesSync(path.join(cacheDir(), name), aged, aged);
    }

    const served = await archive.materializeSessionArchiveForRead(file);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(served, "utf8")).toBe(plaintext);
  }, 120_000);
});
