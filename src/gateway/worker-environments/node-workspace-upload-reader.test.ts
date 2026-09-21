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
import {
  nodeWorkspaceTransferInvalidReason,
  readNodeWorkspaceUpload,
} from "./node-workspace-upload-reader.js";
import * as manifestWorker from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture(controller = new AbortController()) {
  const temporaryRoot = temporary.make("workspace-upload-reader-");
  let authorized = true;
  const authorityError = new Error("upload authority closed");
  const file = Buffer.from("file\0bytes");
  const baseRaw = serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries: [] });
  const currentRaw = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit: null,
    entries: [
      {
        path: "result.bin",
        type: "file",
        mode: 0o644,
        size: file.length,
        sha256: createHash("sha256").update(file).digest("hex"),
      },
    ],
  });
  const bodies = [Buffer.from(baseRaw), Buffer.from(currentRaw), file];
  const payload = Buffer.concat(
    bodies.flatMap((body, index) => {
      const header = Buffer.alloc(index === 2 ? 8 : 4);
      if (header.length === 8) {
        header.writeBigUInt64BE(BigInt(body.length));
      } else {
        header.writeUInt32BE(body.length);
      }
      return [header, body];
    }),
  );
  const upload = (chunks: Buffer[], contentLength = payload.length) => {
    const request = Readable.from(chunks) as unknown as IncomingMessage;
    request.headers = { "content-length": String(contentLength) };
    return readNodeWorkspaceUpload({
      request,
      baseManifestRef: `sha256:${createHash("sha256").update(baseRaw).digest("hex")}`,
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
    payload,
    upload,
    revoke() {
      authorized = false;
      return authorityError;
    },
  };
}

function observeUploadFile(onOpen: (handle: FileHandle) => void) {
  const open = fs.open.bind(fs);
  let closedBytes: Buffer | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === "wx" && path.basename(String(args[0])) === "result.bin") {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        try {
          closedBytes = await fs.readFile(args[0]);
        } finally {
          await close();
        }
      });
      onOpen(handle);
    }
    return handle;
  });
  return { bytesBeforeClose: () => closedBytes };
}

describe("workspace upload byte stream", () => {
  it("uploads and applies a result larger than the former total byte limit", async ({
    onTestFailed,
  }) => {
    const diagnostics = createFixtureDiagnostics("workspace-large-upload");
    onTestFailed(() => diagnostics.report("failure"));
    const temporaryRoot = temporary.make("workspace-large-upload-");
    const local = temporary.make("workspace-large-upload-local-");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    // Exercise the upload size limit without generating a 540 MiB Git text patch.
    chunk[0] = 0;
    const fileBytes = 60 * chunk.length;
    const hash = createHash("sha256");
    for (let index = 0; index < 60; index += 1) {
      hash.update(chunk);
    }
    const sha256 = hash.digest("hex");
    const baseRaw = serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries: [] });
    const entries = Array.from({ length: 9 }, (_, index) => ({
      path: `result-${index}.bin`,
      type: "file" as const,
      mode: 0o644,
      size: fileBytes,
      sha256,
    }));
    const currentRaw = serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries });
    function* body() {
      for (const raw of [baseRaw, currentRaw]) {
        const bytes = Buffer.from(raw);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        yield length;
        yield bytes;
      }
      for (const entry of entries) {
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(entry.size));
        yield length;
        for (let index = 0; index < 60; index += 1) {
          yield chunk;
        }
      }
    }
    const request = Readable.from(body()) as unknown as IncomingMessage;
    request.headers = {
      "content-length": String(
        8 +
          Buffer.byteLength(baseRaw) +
          Buffer.byteLength(currentRaw) +
          entries.length * (8 + fileBytes),
      ),
    };
    diagnostics.stage("upload");
    const upload = await readNodeWorkspaceUpload({
      request,
      temporaryRoot,
      baseManifestRef: `sha256:${createHash("sha256").update(baseRaw).digest("hex")}`,
      signal: new AbortController().signal,
      assertCurrent: () => {},
      isAuthorized: () => true,
    });
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
    const commit = vi.fn();
    diagnostics.stage("apply-result");
    const result = await applyStagedWorkerWorkspaceResult({
      root: local,
      stagedResultRef,
      expectedBaseManifestRef: upload.baseManifestRef,
      journal: { load: () => undefined, begin: () => {}, commit, abort: () => {} },
    });
    diagnostics.stage("assertions");
    expect(result.manifestRef).toBe(upload.currentManifestRef);
    expect(commit).toHaveBeenCalledWith(upload.currentManifestRef);
    for (const entry of entries) {
      expect((await fs.stat(path.join(local, entry.path))).size).toBe(entry.size);
    }
  }, 60_000);

  it.each(["cancellation", "independent failure"] as const)(
    "preserves manifest computation %s when the owner closes",
    async (outcome) => {
      const controller = new AbortController();
      const f = fixture(controller);
      const reason = new Error("upload owner closed");
      const failure =
        outcome === "cancellation"
          ? reason
          : new WorkerTaskError("worker exited before cancellation", "unavailable");
      vi.spyOn(manifestWorker, "decodeWorkspaceManifest").mockImplementationOnce(async () => {
        // The failure is already settled when the reader observes the later abort.
        queueMicrotask(() => controller.abort(reason));
        throw failure;
      });
      await expect(f.upload([f.payload])).rejects.toBe(failure);
      expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
    },
  );
  it("preserves a decode outage without rejecting the manifest", async () => {
    const f = fixture();
    const failure = new WorkerTaskError("workspace computation unavailable", "overloaded");
    vi.spyOn(manifestWorker, "decodeWorkspaceManifest").mockRejectedValueOnce(failure);

    await expect(f.upload([f.payload])).rejects.toBe(failure);
    expect(nodeWorkspaceTransferInvalidReason(failure)).toBeUndefined();
    expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
  });
  it.each(["coalesced", "fragmented", "short writes"])(
    "stages consecutive manifest headers and file bodies in %s chunks",
    async (chunking) => {
      const f = fixture();
      if (chunking === "short writes") {
        observeUploadFile((handle) => {
          const write = handle.write.bind(handle);
          vi.spyOn(handle, "write").mockImplementation(
            (async (bytes: Uint8Array, offset: number, length: number, position: number) =>
              await write(bytes, offset, Math.min(length, 3), position)) as FileHandle["write"],
          );
        });
      }
      const chunks =
        chunking === "fragmented"
          ? Array.from(f.payload, (byte) => Buffer.from([byte]))
          : [f.payload];
      const result = await f.upload(chunks);

      expect(result.baseRaw).toBe(f.baseRaw);
      expect(result.currentRaw).toBe(f.currentRaw);
      expect(await fs.readFile(path.join(result.stagingRoot, "result.bin"))).toEqual(f.file);
    },
  );

  it("checks upload authority before writing after open", async () => {
    const f = fixture();
    let authorityError: Error | undefined;
    const observed = observeUploadFile(() => {
      authorityError = f.revoke();
    });

    const error = await f.upload([f.payload]).catch((failure: unknown) => failure);

    expect(error).toBe(authorityError);
    expect(observed.bytesBeforeClose()).toEqual(Buffer.alloc(0));
    expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
  });

  it("joins a pending short write before cancellation closes and removes staging", async () => {
    const controller = new AbortController();
    const f = fixture(controller);
    const written = createDeferred();
    const release = createDeferred();
    const reason = new Error("upload canceled during write");
    const observed = observeUploadFile((handle) => {
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementationOnce((async (
        bytes: Uint8Array,
        offset: number,
        length: number,
        position: number,
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

  it.each(["zero progress", "I/O error"])(
    "preserves a %s write failure when cancellation also occurs",
    async (failure) => {
      const controller = new AbortController();
      const f = fixture(controller);
      const reason = new Error("upload canceled during failed write");
      const diskError = Object.assign(new Error("upload disk failure"), { code: "EIO" });
      const observed = observeUploadFile((handle) => {
        vi.spyOn(handle, "write").mockImplementationOnce((async (bytes: Uint8Array) => {
          controller.abort(reason);
          if (failure === "I/O error") {
            throw diskError;
          }
          return { bytesWritten: 0, buffer: bytes };
        }) as FileHandle["write"]);
      });

      const error = await f.upload([f.payload]).catch((caught: unknown) => caught);

      if (failure === "I/O error") {
        expect(error).toBe(diskError);
      } else {
        expect(error).toMatchObject({ code: "helper-failed" });
        expect(error).not.toBe(reason);
      }
      expect(observed.bytesBeforeClose()).toEqual(Buffer.alloc(0));
      expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
    },
  );

  it("rejects premature EOF across chunk boundaries", async () => {
    const f = fixture();

    await expect(
      f
        .upload([f.payload.subarray(0, 2), f.payload.subarray(2, 3)])
        .catch(nodeWorkspaceTransferInvalidReason),
    ).resolves.toBe("premature_eof");
    expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
  });

  it.each(["buffered", "next chunk"])("rejects trailing bytes in the %s suffix", async (suffix) => {
    const f = fixture();
    const chunks =
      suffix === "buffered"
        ? [Buffer.concat([f.payload, Buffer.from("!")])]
        : [f.payload, Buffer.from("!")];

    await expect(
      f.upload(chunks, f.payload.length + 1).catch(nodeWorkspaceTransferInvalidReason),
    ).resolves.toBe("trailing_bytes");
    expect(await fs.readdir(f.temporaryRoot)).toEqual([]);
  });
});
