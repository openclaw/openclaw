import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { filesystemStorageProvider } from "./filesystem.js";
import type { StorageBackend, StorageObjectInfo } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function* bytes(value: string) {
  yield Buffer.from(value);
}

async function readBytes(stream: AsyncIterable<Uint8Array> | undefined): Promise<Buffer> {
  expect(stream).toBeDefined();
  if (!stream) {
    throw new Error("Storage object is missing");
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function listKeys(backend: StorageBackend, prefix: string): Promise<string[]> {
  const objects: StorageObjectInfo[] = [];
  for await (const object of backend.listObjects(prefix)) {
    objects.push(object);
  }
  return objects.map((object) => object.key).toSorted();
}

async function openBackend(directory: string): Promise<StorageBackend> {
  return await filesystemStorageProvider.open({
    locationName: "archive",
    settings: { path: directory },
    resolveSecret: async () => {
      throw new Error("Filesystem storage has no credentials");
    },
  });
}

async function withBackend(
  directory: string,
  run: (backend: StorageBackend) => Promise<void>,
): Promise<void> {
  const backend = await openBackend(directory);
  try {
    await run(backend);
  } finally {
    await backend.close?.();
  }
}

describe("filesystem storage provider", () => {
  it("publishes once without clobbering existing bytes and removes its staging files", async () => {
    const directory = tempDirs.make("openclaw-storage-filesystem-");
    await withBackend(directory, async (backend) => {
      await expect(
        backend.putObject("archive.bin", bytes("original"), { sizeBytes: 8 }),
      ).resolves.toEqual({
        sizeBytes: 8,
      });
      await expect(backend.putObject("archive.bin", bytes("replacement"), {})).rejects.toThrow();

      expect(await readBytes(await backend.getObject("archive.bin"))).toEqual(
        Buffer.from("original"),
      );
      await expect(fs.readdir(directory)).resolves.toEqual(["archive.bin"]);
    });
  });

  it("lists nested objects by lexical prefix, reports metadata and space, and deletes idempotently", async () => {
    const directory = tempDirs.make("openclaw-storage-filesystem-");
    await withBackend(directory, async (backend) => {
      await backend.putObject("backups/day-1/a.bin", bytes("one"), {});
      await backend.putObject("backups/day-2/b.bin", bytes("second"), {});
      await backend.putObject("other.bin", bytes("other"), {});
      await fs.writeFile(
        path.join(directory, "backups", ".openclaw-put-incomplete.tmp~"),
        "partial",
      );

      expect(await listKeys(backend, "backups/day-")).toEqual([
        "backups/day-1/a.bin",
        "backups/day-2/b.bin",
      ]);
      expect(await listKeys(backend, "backups/day-1/")).toEqual(["backups/day-1/a.bin"]);
      expect(await listKeys(backend, "missing/")).toEqual([]);
      expect(await listKeys(backend, "")).toEqual([
        "backups/day-1/a.bin",
        "backups/day-2/b.bin",
        "other.bin",
      ]);
      await expect(backend.statObject("backups/day-2/b.bin")).resolves.toEqual({
        key: "backups/day-2/b.bin",
        sizeBytes: 6,
        modifiedAt: expect.any(Number),
      });
      const capacity = await backend.probe();
      expect(capacity.totalBytes).toBeGreaterThan(0);
      expect(capacity.freeBytes).toBeGreaterThanOrEqual(0);
      expect(capacity.freeBytes).toBeLessThanOrEqual(capacity.totalBytes!);

      await backend.deleteObject("backups/day-2/b.bin");
      await backend.deleteObject("backups/day-2/b.bin");
      await expect(backend.getObject("backups/day-2/b.bin")).resolves.toBeUndefined();
      await expect(backend.statObject("backups/day-2/b.bin")).resolves.toBeUndefined();
      expect(await listKeys(backend, "backups/")).toEqual(["backups/day-1/a.bin"]);
    });
  });

  it.each([3, 10])(
    "refuses a mismatched declared size of %s before publication",
    async (sizeBytes) => {
      const directory = tempDirs.make("openclaw-storage-filesystem-");
      await withBackend(directory, async (backend) => {
        await expect(backend.putObject("bad.bin", bytes("value"), { sizeBytes })).rejects.toThrow();
        await expect(backend.getObject("bad.bin")).resolves.toBeUndefined();
        await expect(fs.readdir(directory)).resolves.toEqual([]);
      });
    },
  );

  it("requires an existing absolute directory and never creates a missing root", async () => {
    const directory = tempDirs.make("openclaw-storage-filesystem-");
    await expect(openBackend("relative-storage")).rejects.toThrow(/absolute/u);
    await expect(openBackend(path.join(directory, "missing"))).rejects.toThrow();
    await fs.writeFile(path.join(directory, "file"), "not a directory");
    await expect(openBackend(path.join(directory, "file"))).rejects.toThrow();
    await expect(fs.readdir(directory)).resolves.toEqual(["file"]);
  });

  it("rejects a replaced root during a streamed put without filling its replacement", async () => {
    const directory = tempDirs.make("openclaw-storage-filesystem-");
    const storageRoot = path.join(directory, "mounted");
    await fs.mkdir(storageRoot);
    await withBackend(storageRoot, async (backend) => {
      async function* replaceRootWhileStreaming() {
        yield Buffer.from("first chunk");
        await fs.rename(storageRoot, path.join(directory, "unplugged"));
        await fs.mkdir(storageRoot);
        yield Buffer.from("second chunk");
      }
      await expect(
        backend.putObject("archive.bin", replaceRootWhileStreaming(), {}),
      ).rejects.toThrow();
      await expect(backend.putObject("next.bin", bytes("no"), {})).rejects.toThrow();
      await expect(backend.probe()).rejects.toThrow();
      await expect(fs.readdir(storageRoot)).resolves.toEqual([]);
    });
  });

  it("refuses symlink escapes and excludes them from listings", async () => {
    const directory = tempDirs.make("openclaw-storage-filesystem-");
    const outside = tempDirs.make("openclaw-storage-outside-");
    await fs.writeFile(path.join(outside, "private.bin"), "outside");
    await fs.symlink(outside, path.join(directory, "escape"), "junction");
    await withBackend(directory, async (backend) => {
      await expect(backend.putObject("escape/new.bin", bytes("no"), {})).rejects.toThrow();
      await expect(backend.getObject("escape/private.bin")).rejects.toThrow();
      await expect(backend.deleteObject("escape/private.bin")).rejects.toThrow();
      expect(await listKeys(backend, "")).toEqual([]);
      await expect(fs.readdir(outside)).resolves.toEqual(["private.bin"]);
      await expect(fs.readFile(path.join(outside, "private.bin"), "utf8")).resolves.toBe("outside");
    });
  });
});
