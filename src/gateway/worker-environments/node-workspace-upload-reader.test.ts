import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureDiagnostics } from "../../../test/helpers/fixture-diagnostics.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { interceptUploadFile } from "./node-workspace-transfer-fixtures.test-support.js";
import {
  nodeWorkspaceTransferInvalidReason,
  readNodeWorkspaceUpload,
} from "./node-workspace-upload-reader.js";
import * as manifestWorker from "./workspace-manifest-worker.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const file = Buffer.from("file\0bytes");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifest = (entries: WorkerWorkspaceManifestEntry[] = []) =>
  serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries });
const baseRaw = manifest();
const noop = async () => undefined;
const lengthHeader = (size: number, width = 4) =>
  Buffer.from(size.toString(16).padStart(width * 2, "0"), "hex");
const frame = (body: Buffer, width = 4) => [lengthHeader(body.length, width), body];
type WriteArgs = [bytes: Uint8Array, offset: number, length: number, position: number];

function fixture(
  controller = new AbortController(),
  entries: WorkerWorkspaceManifestEntry[] = [
    { path: "result.bin", type: "file", mode: 0o644, size: file.length, sha256: digest(file) },
  ],
) {
  const temporaryRoot = temporary.make("workspace-upload-reader-");
  let authorized = true;
  const authorityError = new Error("upload authority closed");
  const currentRaw = manifest(entries);
  const headers = [baseRaw, currentRaw].flatMap((raw) => frame(Buffer.from(raw)));
  const payload = Buffer.concat([...headers, ...frame(file, 8)]);
  const upload = (chunks: Iterable<Buffer>, contentLength = payload.length) => {
    const request = Readable.from(chunks) as unknown as IncomingMessage;
    request.headers = { "content-length": String(contentLength) };
    return readNodeWorkspaceUpload({
      request,
      baseManifestRef: `sha256:${digest(Buffer.from(baseRaw))}`,
      temporaryRoot,
      signal: controller.signal,
      assertCurrent: () => {
        controller.signal.throwIfAborted();
        if (!authorized) {
          throw authorityError;
        }
      },
      isAuthorized: () => authorized,
    });
  };
  return {
    temporaryRoot,
    file,
    baseRaw,
    currentRaw,
    headers,
    payload,
    upload,
    revoke() {
      authorized = false;
      return authorityError;
    },
  };
}

function observeUploadFile(onOpen: (handle: FileHandle) => void) {
  let closedBytes: Buffer | undefined;
  interceptUploadFile("result.bin", (handle, uploadPath) => {
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      try {
        closedBytes = await fs.readFile(uploadPath);
      } finally {
        await close();
      }
    });
    onOpen(handle);
  });
  return { bytesBeforeClose: () => closedBytes };
}

describe("workspace upload byte stream", () => {
  it("uploads and applies a result larger than the former total byte limit", async ({
    onTestFailed,
  }) => {
    const diagnostics = createFixtureDiagnostics("workspace-large-upload");
    onTestFailed(() => diagnostics.report("failure"));
    const local = temporary.make("workspace-large-upload-local-");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    // Exercise the upload size limit without generating a 540 MiB Git text patch.
    chunk[0] = 0;
    const chunks = Array.from({ length: 60 }, () => chunk);
    const fileBytes = chunks.length * chunk.length;
    const hash = createHash("sha256");
    for (const bytes of chunks) {
      hash.update(bytes);
    }
    const sha256 = hash.digest("hex");
    const entries = Array.from({ length: 9 }, (_, index) => ({
      path: `result-${index}.bin`,
      type: "file" as const,
      mode: 0o644,
      size: fileBytes,
      sha256,
    }));
    const f = fixture(undefined, entries);
    function* body() {
      yield* f.headers;
      for (const entry of entries) {
        yield lengthHeader(entry.size, 8);
        yield* chunks;
      }
    }
    diagnostics.stage("upload");
    const upload = await f.upload(
      body(),
      f.headers.reduce((size, buffer) => size + buffer.length, 0) +
        entries.length * (8 + fileBytes),
    );
    const stagedResultRef = workerWorkspaceResultRef("large-upload");
    diagnostics.stage("stage-result");
    await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
      root: local,
      stagingRoot: upload.stagingRoot,
      stagedResultRef,
      baseManifestRef: upload.baseManifestRef,
      currentManifestRef: upload.currentManifestRef,
      baseManifestRaw: upload.baseRaw,
      currentManifestRaw: upload.currentRaw,
    });
    const commit = vi.fn(async () => {});
    diagnostics.stage("apply-result");
    const result = await applyStagedWorkerWorkspaceResult({
      root: local,
      stagedResultRef,
      expectedBaseManifestRef: upload.baseManifestRef,
      journal: { load: noop, begin: noop, commit, abort: noop },
    });
    diagnostics.stage("assertions");
    expect(result.manifestRef).toBe(upload.currentManifestRef);
    expect(commit).toHaveBeenCalledWith(upload.currentManifestRef);
    for (const entry of entries) {
      expect((await fs.stat(path.join(local, entry.path))).size).toBe(entry.size);
    }
  }, 60_000);

  it.each(["cancellation", "independent failure", "decode outage"] as const)(
    "preserves manifest computation %s without rejecting the manifest",
    async (outcome) => {
      const controller = new AbortController();
      const f = fixture(controller);
      const reason = new Error("upload owner closed");
      const failure =
        outcome === "cancellation"
          ? reason
          : new WorkerTaskError(
              "workspace computation unavailable",
              outcome === "decode outage" ? "overloaded" : "unavailable",
            );
      vi.spyOn(manifestWorker, "decodeWorkspaceManifest").mockImplementationOnce(async () => {
        // The failure is already settled when the reader observes the later abort.
        if (outcome !== "decode outage") {
          queueMicrotask(() => controller.abort(reason));
        }
        throw failure;
      });
      await expect(f.upload([f.payload])).rejects.toBe(failure);
      expect(nodeWorkspaceTransferInvalidReason(failure)).toBeUndefined();
      expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
    },
  );
  it.each(["fragmented", "short writes"])(
    "stages consecutive manifest headers and file bodies in %s chunks",
    async (chunking) => {
      const f = fixture();
      if (chunking === "short writes") {
        observeUploadFile((handle) => {
          const write = handle.write.bind(handle);
          vi.spyOn(handle, "write").mockImplementation(
            (async (...[bytes, offset, length, position]: WriteArgs) =>
              await write(bytes, offset, Math.min(length, 3), position)) as FileHandle["write"],
          );
        });
      }
      const chunks =
        chunking === "fragmented"
          ? Array.from(f.payload, (byte) => Buffer.from([byte]))
          : [f.payload];
      const result = await f.upload(chunks);

      expect(result).toMatchObject({ baseRaw: f.baseRaw, currentRaw: f.currentRaw });
      expect(await fs.readFile(path.join(result.stagingRoot, "result.bin"))).toEqual(f.file);
    },
  );

  it("joins a pending short write before cancellation closes and removes staging", async () => {
    const controller = new AbortController();
    const f = fixture(controller);
    const written = createDeferred();
    const release = createDeferred();
    const reason = new Error("upload canceled during write");
    const observed = observeUploadFile((handle) => {
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementationOnce((async (
        ...[bytes, offset, length, position]: WriteArgs
      ) => {
        const result = await write(bytes, offset, Math.min(length, 3), position);
        written.resolve();
        await release.promise;
        return result;
      }) as FileHandle["write"]);
    });
    const upload = f.upload([f.payload]).catch((error: unknown) => error);
    try {
      await written.promise;
      controller.abort(reason);
      expect(observed.bytesBeforeClose()).toBeUndefined();
      expect(await fs.readdir(f.temporaryRoot)).toHaveLength(1);
    } finally {
      release.resolve();
    }

    expect(await upload).toBe(reason);
    expect(observed.bytesBeforeClose()).toEqual(f.file.subarray(0, 3));
    expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
  });

  it.each(["authority closed after open", "zero progress", "I/O error"])(
    "stops staging and preserves %s before any bytes are written",
    async (failure) => {
      const controller = new AbortController();
      const f = fixture(controller);
      const reason = new Error("upload canceled during failed write");
      const diskError = Object.assign(new Error("upload disk failure"), { code: "EIO" });
      let authorityError: Error | undefined;
      const observed = observeUploadFile((handle) => {
        if (failure === "authority closed after open") {
          authorityError = f.revoke();
          return;
        }
        vi.spyOn(handle, "write").mockImplementationOnce((async (bytes: Uint8Array) => {
          controller.abort(reason);
          if (failure === "I/O error") {
            throw diskError;
          }
          return { bytesWritten: 0, buffer: bytes };
        }) as FileHandle["write"]);
      });

      const error = await f.upload([f.payload]).catch((caught: unknown) => caught);

      if (failure === "authority closed after open") {
        expect(error).toBe(authorityError);
      } else if (failure === "I/O error") {
        expect(error).toBe(diskError);
      } else {
        expect(error).toMatchObject({ code: "helper-failed" });
        expect(error).not.toBe(reason);
      }
      expect(observed.bytesBeforeClose()).toEqual(Buffer.alloc(0));
      expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
    },
  );

  it.each(["premature EOF", "buffered suffix", "next chunk suffix"])(
    "rejects %s",
    async (suffix) => {
      const f = fixture();
      const truncated = suffix === "premature EOF";
      const chunks = truncated
        ? [f.payload.subarray(0, 2), f.payload.subarray(2, 3)]
        : suffix === "buffered suffix"
          ? [Buffer.concat([f.payload, Buffer.from("!")])]
          : [f.payload, Buffer.from("!")];

      await expect(
        f
          .upload(chunks, f.payload.length + (truncated ? 0 : 1))
          .catch(nodeWorkspaceTransferInvalidReason),
      ).resolves.toBe(truncated ? "premature_eof" : "trailing_bytes");
      expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
    },
  );
});
