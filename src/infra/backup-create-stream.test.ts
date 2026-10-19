import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliJsonFailure } from "../cli/failure-output.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { appendBackupManifest, writeArchiveStreamToFile } from "./backup-create-stream.js";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";
import { formatErrorMessage } from "./errors.js";

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

it("retains bounded progress through cancellation, retry, and CLI error formatting", async () => {
  const archivePath = path.join(tempDirs.make("backup-cancel-"), "partial.tar.gz");
  const source = new PassThrough();
  const read = once(source, "data");
  const controller = new AbortController();
  const reason = Object.freeze(new DOMException("Owner stopped backup", "AbortError"));
  const entrySuffix = `${"a".repeat(170)}/${"b".repeat(170)}/${"c".repeat(169)}`;
  const runTar = vi.fn(() =>
    writeArchiveStreamToFile({
      archivePath,
      createArchiveStream: (report) => {
        report({ phase: "raw", entryPath: `/source/🤖${entrySuffix}`, bytes: 16 });
        return source;
      },
      onPartialArchive: () => {
        throw new Error("Owned unchanged partial archive was not removed");
      },
    }),
  );
  const writing = withCommandProcessScope(
    () => writeTarArchiveWithRetry({ tempArchivePath: archivePath, runTar }),
    controller.signal,
  );
  const observed = writing.catch((error: unknown) => error);
  try {
    source.write("partial archive");
    await read;
    controller.abort(reason);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(source.destroyed).toBe(true);
    const error = await observed;
    const message = `Backup archive write failed: The operation was aborted (phase=output, entry=${JSON.stringify(entrySuffix)}, rawBytes=16, outputBytes=15) (after 1 attempt)`;
    expect(error).toMatchObject({
      message,
      cause: { name: "AbortError", code: "ABORT_ERR", cause: { cause: reason } },
    });
    expect(formatCliJsonFailure(error, { argv: [], env: {} }).error.message).toBe(message);
    expect(formatErrorMessage(error)).toContain(message);
    expect(runTar).toHaveBeenCalledTimes(1);
    expect(controller.signal.reason).toBe(reason);
    expect(reason.message).toBe("Owner stopped backup");
    expect(source.closed).toBe(true);
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    source.destroy(new Error("Fixture cleanup"));
    await observed;
  }
});

it("preserves a shared abort reason and its numeric code before the output opens", async () => {
  const archivePath = path.join(tempDirs.make("backup-sync-cancel-"), "partial.tar.gz");
  const controller = new AbortController();
  const reason = Object.freeze(new DOMException("Owner stopped backup", "AbortError"));
  const writing = withCommandProcessScope(
    () =>
      writeArchiveStreamToFile({
        archivePath,
        createArchiveStream(report, signal) {
          report({ phase: "traversal", entryPath: "/source/workspace" });
          controller.abort(reason);
          signal.throwIfAborted();
          throw new Error("Expected cancellation");
        },
        onPartialArchive() {},
      }),
    controller.signal,
  );
  const error: unknown = await writing.catch((caught: unknown) => caught);
  expect(error).not.toBe(reason);
  expect(error).toMatchObject({
    name: "AbortError",
    code: 20,
    cause: reason,
    message:
      'Owner stopped backup (phase=traversal, entry="/source/workspace", rawBytes=0, outputBytes=0)',
  });
  expect(reason.message).toBe("Owner stopped backup");
  expect(reason.code).toBe(20);
  await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
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
  const controller = new AbortController();
  const failure = Object.assign(new Error("Producer failed before returning a stream"), {
    code: "EACCES",
  });
  const writing = withCommandProcessScope(
    () =>
      writeArchiveStreamToFile({
        archivePath,
        createArchiveStream() {
          controller.abort();
          throw failure;
        },
        onPartialArchive() {},
      }),
    controller.signal,
  );
  const output = outputs[previousOutputs]!;
  try {
    await expect(writing).rejects.toBe(failure);
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
