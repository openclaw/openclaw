import fs from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { afterEach, assert, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { filesystemStorageProvider } from "./filesystem.js";
import type { StorageBackend } from "./types.js";

const backends: StorageBackend[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all(
        backends.splice(0).map(async (backend) => {
          await backend.close?.();
        }),
      );
    } finally {
      cleanup();
    }
  }),
);

async function* bytes(value: string) {
  yield Buffer.from(value);
}

async function openBackend(root = tempDirs.make("openclaw-storage-filesystem-")) {
  const backend = await filesystemStorageProvider.open({
    locationName: "archive",
    settings: { path: root },
    resolveSecret: () => Promise.reject(new Error("Filesystem storage has no credentials")),
  });
  backends.push(backend);
  return { backend, directory: root };
}

async function listKeys(backend: StorageBackend, prefix: string) {
  const keys: string[] = [];
  for await (const { key } of backend.listObjects(prefix)) {
    keys.push(key);
  }
  return keys.toSorted();
}

it("publishes once without clobbering bytes or leaving staging files", async () => {
  const { backend, directory } = await openBackend();
  expect(await backend.putObject("a", bytes("original"), { sizeBytes: 8 })).toEqual({
    sizeBytes: 8,
  });
  await expect(backend.putObject("a", bytes("replacement"), {})).rejects.toThrow();
  const stream = await backend.getObject("a");
  assert(stream, "Storage object is missing");
  expect(await buffer(stream)).toEqual(Buffer.from("original"));
  await expect(fs.readdir(directory)).resolves.toEqual(["a"]);
});

it("lists prefixes, reports metadata and space, and deletes idempotently", async () => {
  const { backend, directory } = await openBackend();
  const first = "backups/day-1/a.bin",
    second = "backups/day-2/b.bin";
  for (const key of [first, second, "other.bin"]) {
    await backend.putObject(key, bytes("second"), {});
  }
  await fs.writeFile(path.join(directory, "backups", ".openclaw-put-incomplete.tmp~"), "partial");
  for (const [prefix, expected] of [
    ["backups/day-", [first, second]],
    ["backups/day-1/", [first]],
    ["missing/", []],
    ["", [first, second, "other.bin"]],
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

it.each([3, 10])("refuses declared size %s before publication", async (sizeBytes) => {
  const { backend, directory } = await openBackend();
  await expect(backend.putObject("bad.bin", bytes("value"), { sizeBytes })).rejects.toThrow();
  await expect(backend.getObject("bad.bin")).resolves.toBeUndefined();
  await expect(fs.readdir(directory)).resolves.toEqual([]);
});

it("requires an existing absolute directory without creating a missing root", async () => {
  const directory = tempDirs.make("openclaw-storage-filesystem-");
  await expect(openBackend("relative-storage")).rejects.toThrow(/absolute/u);
  await expect(openBackend(path.join(directory, "missing"))).rejects.toThrow();
  await fs.writeFile(path.join(directory, "file"), "not a directory");
  await expect(openBackend(path.join(directory, "file"))).rejects.toThrow();
  await expect(fs.readdir(directory)).resolves.toEqual(["file"]);
});

it("rejects a replaced root during streaming without filling its replacement", async () => {
  const directory = tempDirs.make("openclaw-storage-filesystem-");
  const storageRoot = path.join(directory, "mounted");
  await fs.mkdir(storageRoot);
  const { backend } = await openBackend(storageRoot);
  async function* replaceRootWhileStreaming() {
    yield Buffer.from("first chunk");
    await fs.rename(storageRoot, path.join(directory, "unplugged"));
    await fs.mkdir(storageRoot);
    yield Buffer.from("second chunk");
  }
  await expect(backend.putObject("archive.bin", replaceRootWhileStreaming(), {})).rejects.toThrow();
  await expect(backend.putObject("next.bin", bytes("no"), {})).rejects.toThrow();
  await expect(backend.probe()).rejects.toThrow();
  await expect(fs.readdir(storageRoot)).resolves.toEqual([]);
  await fs.writeFile(path.join(storageRoot, "kept"), "preserved");
  await expect(backend.deleteObject("kept")).rejects.toThrow();
  await expect(fs.readFile(path.join(storageRoot, "kept"), "utf8")).resolves.toBe("preserved");
});

it("refuses symlink escapes and excludes them from listings", async () => {
  const outside = tempDirs.make("openclaw-storage-outside-");
  await fs.writeFile(path.join(outside, "private.bin"), "outside");
  const { backend, directory } = await openBackend();
  await fs.symlink(outside, path.join(directory, "escape"), "junction");
  await expect(backend.putObject("escape/new.bin", bytes("no"), {})).rejects.toThrow();
  await expect(backend.getObject("escape/private.bin")).rejects.toThrow();
  await expect(backend.deleteObject("escape/private.bin")).rejects.toThrow();
  expect(await listKeys(backend, "")).toEqual([]);
  await expect(fs.readdir(outside)).resolves.toEqual(["private.bin"]);
  await expect(fs.readFile(path.join(outside, "private.bin"), "utf8")).resolves.toBe("outside");
});
