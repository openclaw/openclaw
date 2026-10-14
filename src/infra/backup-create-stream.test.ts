import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { appendBackupManifest, writeArchiveStreamToFile } from "./backup-create-stream.js";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";

const outputs = vi.hoisted(() => [] as import("node:fs").WriteStream[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream(...args: Parameters<typeof actual.createWriteStream>) {
      const output = actual.createWriteStream(...args);
      outputs.push(output);
      return output;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("cancels an EOF retry backoff without starting another archive", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const runTar = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error("Synthetic live-write race"), { code: "EOF" }))
    .mockResolvedValue("complete");
  const writing = withCommandProcessScope(
    () =>
      writeTarArchiveWithRetry({
        tempArchivePath: "synthetic-partial.tar.gz",
        runTar,
        log: () => controller.abort(),
      }),
    controller.signal,
  );
  const observed = writing.catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    expect(runTar).toHaveBeenCalledTimes(1);
  } finally {
    await observed;
    vi.useRealTimers();
  }
});

it("joins command-scope cancellation before checked partial cleanup", async () => {
  const archivePath = path.join(tempDirs.make("backup-cancel-"), "partial.tar.gz");
  const source = new PassThrough();
  const read = once(source, "data");
  const controller = new AbortController();
  const writing = withCommandProcessScope(
    () =>
      writeArchiveStreamToFile({
        archivePath,
        createArchiveStream: () => source,
        onPartialArchive: () => {
          throw new Error("Owned unchanged partial archive was not removed");
        },
      }),
    controller.signal,
  );
  const observed = writing.catch((error: unknown) => error);
  try {
    source.write("partial archive");
    await read;
    controller.abort();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(source.destroyed).toBe(true);
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    expect(source.closed).toBe(true);
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    source.destroy(new Error("Fixture cleanup"));
    await observed;
  }
});

it("preserves an existing archive when exclusive creation is refused", async () => {
  const archivePath = path.join(tempDirs.make("backup-existing-"), "existing.tar.gz");
  await fs.writeFile(archivePath, "existing archive");
  const source = new PassThrough();
  source.end("new archive");
  await expect(
    writeArchiveStreamToFile({
      archivePath,
      createArchiveStream: () => source,
      onPartialArchive() {},
    }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("existing archive");
});

it("joins a pending output open before cleaning up a synchronous producer failure", async () => {
  const archivePath = path.join(tempDirs.make("backup-producer-failed-"), "partial.tar.gz");
  const previousOutputs = outputs.length;
  const writing = writeArchiveStreamToFile({
    archivePath,
    createArchiveStream() {
      throw new Error("Producer failed before returning a stream");
    },
    onPartialArchive() {},
  });
  const output = outputs[previousOutputs]!;
  try {
    await expect(writing).rejects.toThrow("Producer failed before returning a stream");
    expect(output.closed).toBe(true);
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (!output.closed) {
      await once(output, "close");
    }
  }
});

it.each([511, 1024, 1025, 8193])(
  "replaces the final tar terminator after traversal with %i-byte chunks",
  async (chunkSize) => {
    const payload = Buffer.concat([
      Buffer.from(Array.from({ length: 7169 }, (_, index) => index % 251)),
      Buffer.alloc(1024),
    ]);
    const manifest = Buffer.from("manifest captured after traversal");
    let traversed = false;
    async function* chunks() {
      yield Buffer.alloc(0);
      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        yield payload.subarray(offset, offset + chunkSize);
      }
      traversed = true;
    }
    const archive = await buffer(
      appendBackupManifest(chunks(), () => {
        expect(traversed).toBe(true);
        return manifest;
      }),
    );
    expect(gunzipSync(archive)).toEqual(Buffer.concat([payload.subarray(0, -1024), manifest]));
  },
);
