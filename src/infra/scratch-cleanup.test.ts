import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { SCRATCH_TTL_MS } from "../shared/scratch-expiry.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { listDirectoryTreeStrict } from "./directory-walk.js";
import {
  cleanScratch,
  closeScratchCleanupCursor,
  type ScratchCleanupCursor,
  type ScratchCleanupTarget,
} from "./scratch-cleanup.js";

const tempDirs = createTrackedTempDirs();
const now = 1_800_000_000_000;
const cursors: ScratchCleanupCursor[] = [];
afterEach(async () => {
  for (const cursor of cursors.splice(0)) {
    await closeScratchCleanupCursor(cursor);
  }
  await tempDirs.cleanup();
});

async function fixture() {
  const root = await fs.realpath(await tempDirs.make("scratch-cleanup-"));
  const target: ScratchCleanupTarget = { root, kind: "checkout", isLive: () => false };
  const cursor: ScratchCleanupCursor = {};
  cursors.push(cursor);
  const pause = vi.fn(async (_milliseconds: number) => {});
  return {
    root,
    target,
    cursor,
    pause,
    async file(name: string, age = SCRATCH_TTL_MS + 1) {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "proof");
      await fs.utimes(file, (now - age) / 1000, (now - age) / 1000);
      return file;
    },
    run: (nextCursor = cursor) =>
      cleanScratch({ targets: [target], now, assertCurrent: () => {}, pause, cursor: nextCursor }),
  };
}

it("expires only entries whose newest file is older than 24 hours, retaining boundary and fresh children", async () => {
  const f = await fixture();
  const expired = await f.file(".openclaw/tmp/expired/nested/proof");
  const boundary = await f.file(".openclaw/tmp/boundary/proof", SCRATCH_TTL_MS);
  const fresh = await f.file(".openclaw/tmp/mixed/fresh", 1);
  const oldSibling = await f.file(".openclaw/tmp/mixed/old");
  const outside = await f.file("source.txt");
  // A prior partial drain may leave a newly empty directory beside old files.
  const empty = path.join(f.root, ".openclaw/tmp/expired/empty");
  await fs.mkdir(empty);
  await fs.utimes(empty, now / 1000, now / 1000);
  const result = await f.run();
  expect(result).toMatchObject({ entriesRemoved: 1, bytesRemoved: 5, skippedLive: 0, errors: [] });
  await expect(fs.stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.readdir(path.join(f.root, ".openclaw/tmp"))).toSorted()).toEqual([
    "boundary",
    "mixed",
  ]);
  for (const file of [boundary, fresh, oldSibling, outside]) {
    expect(await fs.readFile(file, "utf8")).toBe("proof");
  }
});

it("retains a replacement entry when identity changes after expiry inspection", async () => {
  const f = await fixture();
  const directory = path.dirname(await f.file(".openclaw/tmp/expired/proof"));
  let preparations = 0;
  f.target.prepare = async () => {
    if (++preparations === 2) {
      await fs.rename(directory, path.join(f.root, "retained-original"));
      await f.file(".openclaw/tmp/expired/fresh", 1);
    }
  };
  expect(await f.run()).toMatchObject({ entriesRemoved: 0, filesRemoved: 0, deferred: 1 });
  expect(await fs.readFile(path.join(directory, "fresh"), "utf8")).toBe("proof");
  expect(await fs.readFile(path.join(f.root, "retained-original/proof"), "utf8")).toBe("proof");
});

it("skips live custody and isolates claimed cleanup from new work at the original path", async () => {
  const f = await fixture();
  f.target.isLive = () => true;
  const file = await f.file(".openclaw/tmp/proof/file");
  expect(await f.run()).toMatchObject({ skippedLive: 1, filesRemoved: 0, scanned: 0 });
  expect(await fs.readFile(file, "utf8")).toBe("proof");
  f.target.isLive = () => false;
  for (let index = 0; index < 129; index++) {
    await f.file(`.openclaw/tmp/proof/${index}`);
  }
  f.pause.mockImplementation(async () => {
    await expect(fs.stat(path.dirname(file))).rejects.toMatchObject({ code: "ENOENT" });
    await f.file(".openclaw/tmp/proof/fresh", 1);
    f.target.isLive = () => true;
  });
  expect(await f.run()).toMatchObject({ filesRemoved: 131, entriesRemoved: 1, errors: [] });
  expect(f.pause).toHaveBeenCalledExactlyOnceWith(100);
  expect(await fs.readdir(path.dirname(file))).toEqual(["fresh"]);
});

it("joins worker cancellation at a deletion checkpoint before releasing the checkout", async () => {
  const f = await fixture();
  const controller = new AbortController();
  for (let index = 0; index < 130; index++) {
    await f.file(`.openclaw/tmp/proof/${index}`);
  }
  await expect(
    cleanScratch({
      targets: [f.target],
      now,
      cursor: f.cursor,
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
      pause: async () => controller.abort(),
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const remaining = await fs.readdir(path.join(f.root, ".openclaw/tmp"));
  expect(remaining).toHaveLength(1);
  expect(await fs.readdir(path.join(f.root, ".openclaw/tmp", remaining[0]!))).toHaveLength(2);
  // Ordinary expiry rediscovers the partially drained entry without a claim journal.
  expect(await f.run()).toMatchObject({ entriesRemoved: 1, filesRemoved: 3, errors: [] });
  expect(await fs.readdir(path.join(f.root, ".openclaw/tmp"))).toEqual([]);
});

it("resumes a claimed tree after a process crash without touching a replacement checkout", async () => {
  const f = await fixture();
  await f.file(".openclaw/tmp/proof/.git/HEAD");
  for (let index = 0; index < 130; index++) {
    await f.file(`.openclaw/tmp/proof/${index}`);
  }
  const run = (crash: boolean) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
        "--input-type=module",
        "--eval",
        `import { writeSync } from "node:fs";
         const { cleanScratch, closeScratchCleanupCursor } = await import(${JSON.stringify(new URL("./scratch-cleanup.ts", import.meta.url).href)});
         const cursor = {};
         const result = await cleanScratch({
           targets: [{ root: process.argv[1], kind: "checkout", isLive: () => false }],
           now: Number(process.argv[2]), cursor, assertCurrent() {},
           async pause() {
             if (process.argv[3] === "true") {
               writeSync(1, "deletion checkpoint\\n");
               process.kill(process.pid, "SIGKILL");
             }
           },
         });
         await closeScratchCleanupCursor(cursor);
         writeSync(1, JSON.stringify(result));
         process.exit(0);`,
        f.root,
        String(now),
        String(crash),
      ],
      { timeout: 30_000 },
    );
  await expect(run(true)).rejects.toMatchObject({
    signal: "SIGKILL",
    killed: false,
    stdout: "deletion checkpoint\n",
  });
  const scratch = path.join(f.root, ".openclaw/tmp");
  const claims = await fs.readdir(scratch);
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatch(/^\.reclaim-/);
  // 131 files, the Git directory and the claimed root, less the first 128 removals.
  expect(await listDirectoryTreeStrict(path.join(scratch, claims[0]!))).toHaveLength(4);
  const fresh = await f.file(".openclaw/tmp/proof/fresh", 1);
  const resumed = await run(false);
  expect(JSON.parse(resumed.stdout)).toMatchObject({
    entriesRemoved: 1,
    filesRemoved: 5,
    deferred: 0,
    errors: [],
  });
  expect(await fs.readdir(scratch)).toEqual(["proof"]);
  expect(await fs.readFile(fresh, "utf8")).toBe("proof");
}, 60_000);

it("refuses symlink scratch roots but expires contained links without following their targets", async () => {
  const f = await fixture();
  const outside = await f.file("outside/proof");
  await fs.mkdir(path.join(f.root, ".openclaw"));
  await fs.symlink(path.join(f.root, "outside"), path.join(f.root, ".openclaw/tmp"), "dir");
  expect(await f.run()).toMatchObject({ filesRemoved: 0, deferred: 1 });
  await fs.unlink(path.join(f.root, ".openclaw/tmp"));
  await fs.mkdir(path.join(f.root, ".openclaw/tmp/proof"), { recursive: true });
  const link = path.join(f.root, ".openclaw/tmp/proof/link");
  await fs.symlink(outside, link);
  await fs.lutimes(link, (now - SCRATCH_TTL_MS - 1) / 1000, (now - SCRATCH_TTL_MS - 1) / 1000);
  expect(await f.run()).toMatchObject({ entriesRemoved: 1, filesRemoved: 2, deferred: 0 });
  expect(await fs.readFile(outside, "utf8")).toBe("proof");
});

it("expires nested clone object links by directory age, not another checkout's pack refresh", async () => {
  const f = await fixture();
  const shared = await f.file("base/.git/objects/pack/pack-synthetic.pack", 1);
  const clone = path.join(f.root, ".openclaw/tmp/landing/native");
  await f.file(".openclaw/tmp/landing/native/.git/FETCH_HEAD");
  const packs = path.join(clone, ".git/objects/pack");
  await fs.mkdir(packs, { recursive: true });
  await fs.link(shared, path.join(packs, "pack-synthetic.pack"));
  const old = (now - SCRATCH_TTL_MS - 1) / 1000;
  // A newly linked object still protects the entry until its directory ages out.
  await fs.utimes(packs, now / 1000, now / 1000);
  expect(await f.run()).toMatchObject({ entriesRemoved: 0, errors: [] });
  await fs.utimes(packs, old, old);
  expect(await f.run()).toMatchObject({ entriesRemoved: 1, errors: [] });
  await expect(fs.stat(clone)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(shared, "utf8")).toBe("proof");
  expect((await fs.stat(shared)).nlink).toBe(1);
});

it.each(["checkout", "coverage"] as const)(
  "resumes bounded %s cleanup after losing its cursor",
  async (kind) => {
    const f = await fixture();
    f.target.kind = kind;
    const prefix = kind === "checkout" ? ".openclaw/tmp/" : "";
    const unrelated = await f.file("other-temp/proof");
    const regular = await f.file("node-coverage-file");
    for (let index = 0; index < 258; index++) {
      await f.file(`${prefix}node-coverage-${index}/proof`);
    }
    expect(await f.run()).toMatchObject({ entriesRemoved: 256, bytesRemoved: 1280 });
    await closeScratchCleanupCursor(f.cursor);
    const restartedCursor: ScratchCleanupCursor = {};
    cursors.push(restartedCursor);
    expect(await f.run(restartedCursor)).toMatchObject({
      entriesRemoved: 2,
      bytesRemoved: 10,
      scanned: kind === "checkout" ? 4 : 6,
      errors: [],
    });
    expect(await f.run(restartedCursor)).toMatchObject({
      entriesRemoved: 0,
      filesRemoved: 0,
      scanned: kind === "checkout" ? 0 : 2,
    });
    expect(await fs.readFile(unrelated, "utf8")).toBe("proof");
    expect(await fs.readFile(regular, "utf8")).toBe("proof");
  },
);

it("retains an entry when its newest file cannot be established within the scan depth", async () => {
  const f = await fixture();
  const file = await f.file(`.openclaw/tmp/proof/${"nested/".repeat(65)}old`);
  const result = await f.run();
  expect(result).toMatchObject({ entriesRemoved: 0, filesRemoved: 0, deferred: 1 });
  expect(result.errors[0]).toContain("scan budget exhausted");
  expect(await fs.readFile(file, "utf8")).toBe("proof");
});

it("resumes beyond 4096 names without restarting the prefix or deleting outside scratch", async () => {
  const f = await fixture();
  const directory = path.join(f.root, ".openclaw/tmp");
  await fs.mkdir(directory, { recursive: true });
  for (let start = 0; start < 4100; start += 32) {
    await Promise.all(
      Array.from({ length: Math.min(32, 4100 - start) }, (_, offset) =>
        f.file(`.openclaw/tmp/fresh-${start + offset}`, 1),
      ),
    );
  }
  // Use the actual filesystem order; only the final name is old enough to expire.
  let last = "";
  for await (const entry of await fs.opendir(directory)) {
    last = entry.name;
  }
  const expired = path.join(directory, last);
  await fs.utimes(expired, (now - SCRATCH_TTL_MS - 1) / 1000, (now - SCRATCH_TTL_MS - 1) / 1000);
  const outside = await f.file("outside.txt");
  let removed = 0;
  for (let pass = 0; pass < 17; pass++) {
    removed += (await f.run()).entriesRemoved;
  }
  expect(removed).toBe(1);
  await expect(fs.stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(outside, "utf8")).toBe("proof");
  expect(await fs.readdir(directory)).toHaveLength(4099);
}, 60_000);
