import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SCRATCH_TTL_MS } from "../shared/scratch-expiry.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
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
    run: () => cleanScratch({ targets: [target], now, assertCurrent: () => {}, pause, cursor }),
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
  for (const file of [boundary, fresh, oldSibling, outside]) {
    expect(await fs.readFile(file, "utf8")).toBe("proof");
  }
});

it("skips live or queued custody and stops paced deletion when custody becomes live", async () => {
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
    f.target.isLive = () => true;
  });
  expect(await f.run()).toMatchObject({ skippedLive: 1, filesRemoved: 128, entriesRemoved: 0 });
  expect(f.pause).toHaveBeenCalledExactlyOnceWith(100);
  expect((await fs.readdir(path.dirname(file))).length).toBe(2);
});

it("refuses symlinks at the scratch boundary and inside entries without deleting outside files", async () => {
  const f = await fixture();
  const outside = await f.file("outside/proof");
  await fs.mkdir(path.join(f.root, ".openclaw"));
  await fs.symlink(path.join(f.root, "outside"), path.join(f.root, ".openclaw/tmp"), "dir");
  expect(await f.run()).toMatchObject({ filesRemoved: 0, deferred: 1 });
  await fs.unlink(path.join(f.root, ".openclaw/tmp"));
  await fs.mkdir(path.join(f.root, ".openclaw/tmp/proof"), { recursive: true });
  await fs.symlink(outside, path.join(f.root, ".openclaw/tmp/proof/link"));
  expect(await f.run()).toMatchObject({ filesRemoved: 0, deferred: 1 });
  expect(await fs.readFile(outside, "utf8")).toBe("proof");
});

it("cleans only node-coverage directories in runtime temp and advances a bounded pass", async () => {
  const f = await fixture();
  f.target.kind = "coverage";
  const unrelated = await f.file("other-temp/proof");
  const regular = await f.file("node-coverage-file");
  for (let index = 0; index < 258; index++) {
    await f.file(`node-coverage-${index}/proof`);
  }
  expect(await f.run()).toMatchObject({ entriesRemoved: 256, bytesRemoved: 1280 });
  expect(await f.run()).toMatchObject({ entriesRemoved: 2, bytesRemoved: 10 });
  expect(await fs.readFile(unrelated, "utf8")).toBe("proof");
  expect(await fs.readFile(regular, "utf8")).toBe("proof");
});

it("retains an entry when its newest file cannot be established within the scan depth", async () => {
  const f = await fixture();
  const file = await f.file(`.openclaw/tmp/proof/${"nested/".repeat(65)}old`);
  const result = await f.run();
  expect(result).toMatchObject({ entriesRemoved: 0, filesRemoved: 0, deferred: 1 });
  expect(result.errors[0]).toContain("scan budget exhausted");
  expect(await fs.readFile(file, "utf8")).toBe("proof");
});

it("keeps scanning when a pending candidate vanished between maintenance passes", async () => {
  const f = await fixture();
  const proof = await f.file(".openclaw/tmp/a/proof");
  // A budget-exhausted pass retains its pending candidate; the scratch owner
  // may remove it before the next pass, which must not abandon the remaining
  // top-level scan or silently reset the directory cursor.
  f.cursor.root = f.root;
  f.cursor.kind = "checkout";
  f.cursor.pending = path.join(".openclaw/tmp", "gone");
  const result = await f.run();
  expect(result.errors).toEqual([]);
  expect(result.entriesRemoved).toBe(1);
  await expect(fs.stat(proof)).rejects.toMatchObject({ code: "ENOENT" });
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
