import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      assertCurrent: () => {},
      isAuthorized: () => true,
    });
  };
  return { temporaryRoot, file, baseRaw, currentRaw, payload, upload };
}

describe("workspace upload byte stream", () => {
  it("uploads and applies a result larger than the former total byte limit", async () => {
    const temporaryRoot = temporary.make("workspace-large-upload-");
    const local = temporary.make("workspace-large-upload-local-");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
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
    const upload = await readNodeWorkspaceUpload({
      request,
      temporaryRoot,
      baseManifestRef: `sha256:${createHash("sha256").update(baseRaw).digest("hex")}`,
      signal: new AbortController().signal,
      assertCurrent: () => {},
      isAuthorized: () => true,
    });
    const stagedResultRef = workerWorkspaceResultRef("large-upload");
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
    const result = await applyStagedWorkerWorkspaceResult({
      root: local,
      stagedResultRef,
      expectedBaseManifestRef: upload.baseManifestRef,
      journal: { load: () => undefined, begin: () => {}, commit, abort: () => {} },
    });
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
  it.each(["coalesced", "fragmented"])(
    "stages consecutive manifest headers and file bodies in %s chunks",
    async (chunking) => {
      const f = fixture();
      const chunks =
        chunking === "coalesced"
          ? [f.payload]
          : Array.from(f.payload, (byte) => Buffer.from([byte]));
      const result = await f.upload(chunks);

      expect(result.baseRaw).toBe(f.baseRaw);
      expect(result.currentRaw).toBe(f.currentRaw);
      expect(await fs.readFile(path.join(result.stagingRoot, "result.bin"))).toEqual(f.file);
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
