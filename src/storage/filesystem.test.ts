import fs from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { assert, expect, it } from "vitest";
import { collect } from "../../test/helpers/async-iterable.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { filesystemStorageProvider } from "./filesystem.js";
import type { StorageBackend } from "./types.js";

const test = it.extend<{ store: [backend: StorageBackend, dir: string] }>({
  store: async ({ task: _task }, use) =>
    withTempDir("openclaw-storage-", async (parent) => {
      const dir = path.join(parent, "mounted");
      await fs.mkdir(dir);
      const backend = await openBackend(dir);
      try {
        await use([backend, dir]);
      } finally {
        await backend.close?.();
      }
    }),
});

async function* bytes(value: string) {
  yield Buffer.from(value);
}

function openBackend(root: string) {
  return filesystemStorageProvider.open({
    locationName: "archive",
    settings: { path: root },
    resolveSecret: () => Promise.reject(new Error("Filesystem storage has no credentials")),
  });
}

const listKeys = async (backend: StorageBackend, prefix: string) =>
  (await collect(backend.listObjects(prefix))).map(({ key }) => key).toSorted();

test("publishes, lists, probes, and deletes objects", async ({ store: [backend, dir] }) => {
  expect(await backend.putObject("a", bytes("old"), { sizeBytes: 3 })).toEqual({ sizeBytes: 3 });
  await expect(backend.putObject("a", bytes("replacement"), {})).rejects.toThrow();
  const stream = await backend.getObject("a");
  assert(stream, "Storage object is missing");
  expect(await buffer(stream)).toEqual(Buffer.from("old"));
  await expect(fs.readdir(dir)).resolves.toEqual(["a"]);
  const [first, second] = ["backups/day-1/a.bin", "backups/day-2/b.bin"];
  for (const key of [first, second, "other.bin"]) {
    await backend.putObject(key, bytes("second"), {});
  }
  await fs.writeFile(path.join(dir, "backups", ".openclaw-put-incomplete.tmp~"), "partial");
  for (const [prefix, expected] of [
    ["backups/day-", [first, second]],
    ["backups/day-1/", [first]],
    ["missing/", []],
    ["", ["a", first, second, "other.bin"]],
  ] as const) {
    expect(await listKeys(backend, prefix)).toEqual(expected);
  }
  const metadata = await backend.statObject(second);
  expect(metadata).toEqual({ key: second, sizeBytes: 6, modifiedAt: expect.any(Number) });
  const capacity = await backend.probe();
  expect(capacity.totalBytes).toBeGreaterThan(0);
  expect(capacity.freeBytes).toBeGreaterThanOrEqual(0);
  expect(capacity.freeBytes).toBeLessThanOrEqual(capacity.totalBytes!);
  await backend.deleteObject(second);
  await backend.deleteObject(second);
  await expect(backend.getObject(second)).resolves.toBeUndefined();
  await expect(backend.statObject(second)).resolves.toBeUndefined();
  expect(await listKeys(backend, "backups/")).toEqual([first]);
});

test.for([3, 10])("rejects declared size %s", async (sizeBytes, { store: [backend, dir] }) => {
  await expect(backend.putObject("bad.bin", bytes("value"), { sizeBytes })).rejects.toThrow();
  await expect(fs.readdir(dir)).resolves.toEqual([]);
});

test("requires an existing absolute directory", async ({ store: [, dir] }) => {
  await expect(openBackend("relative-storage")).rejects.toThrow(/absolute/u);
  await expect(openBackend(path.join(dir, "missing"))).rejects.toThrow();
  await fs.writeFile(path.join(dir, "file"), "not a directory");
  await expect(openBackend(path.join(dir, "file"))).rejects.toThrow();
  await expect(fs.readdir(dir)).resolves.toEqual(["file"]);
});

test("rejects replaced roots", async ({ store: [backend, dir] }) => {
  async function* replaceRootWhileStreaming() {
    yield Buffer.from("first chunk");
    await fs.rename(dir, path.join(dir, "..", "unplugged"));
    await fs.mkdir(dir);
    yield Buffer.from("second chunk");
  }
  await expect(backend.putObject("archive.bin", replaceRootWhileStreaming(), {})).rejects.toThrow();
  await expect(backend.putObject("next.bin", bytes("no"), {})).rejects.toThrow();
  await expect(backend.probe()).rejects.toThrow();
  await expect(fs.readdir(dir)).resolves.toEqual([]);
  await fs.writeFile(path.join(dir, "kept"), "preserved");
  await expect(backend.deleteObject("kept")).rejects.toThrow();
  await expect(fs.readFile(path.join(dir, "kept"), "utf8")).resolves.toBe("preserved");
});

test("blocks symlink escapes and excludes them from lists", async ({ store: [backend, dir] }) => {
  const outside = path.join(dir, "..", "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.bin"), "outside");
  await fs.symlink(outside, path.join(dir, "escape"), "junction");
  await expect(backend.putObject("escape/new.bin", bytes("no"), {})).rejects.toThrow();
  await expect(backend.getObject("escape/private.bin")).rejects.toThrow();
  await expect(backend.deleteObject("escape/private.bin")).rejects.toThrow();
  expect(await listKeys(backend, "")).toEqual([]);
  await expect(fs.readdir(outside)).resolves.toEqual(["private.bin"]);
  await expect(fs.readFile(path.join(outside, "private.bin"), "utf8")).resolves.toBe("outside");
});
