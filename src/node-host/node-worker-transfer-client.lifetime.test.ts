import { createHash } from "node:crypto";
import { errorMonitor } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http, { createServer as createHttpServer, type RequestOptions } from "node:http";
import { connect as connectNet } from "node:net";
import path from "node:path";
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { readActualWorkspaceManifest } from "../gateway/worker-environments/workspace-reconcile-core.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function uploadFixture(content: string | Buffer) {
  const root = tempDirs.make("node-worker-transfer-lifetime-");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "result.txt"), content);
  const currentRef = (await readActualWorkspaceManifest({ root: workspaceDir, baseCommit: null }))
    .manifestRef;
  const baseRaw = serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries: [] });
  const baseDigest = createHash("sha256").update(baseRaw).digest("hex");
  const manifestDir = path.join(root, ".openclaw-worker", "manifests");
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(path.join(manifestDir, `${baseDigest}.json`), baseRaw);
  return {
    currentRef,
    upload: (gatewayUrl: string, signal?: AbortSignal) =>
      runNodeWorkerWorkspaceTransfer({
        gatewayUrl,
        environmentId: "environment-upload-lifetime",
        workspaceDir,
        manifestHome: root,
        signal,
        transfer: {
          direction: "upload",
          token: "upload-token",
          baseManifestRef: `sha256:${baseDigest}`,
          referenceManifestRef: `sha256:${baseDigest}`,
        },
      }),
  };
}

describe("node worker upload HTTP lifetime", () => {
  it("accepts a complete response before the final backpressure drain", async () => {
    const f = await uploadFixture(Buffer.alloc(2 * 1024 * 1024, "a"));
    const readClosed = createDeferred();
    let readOpened = false;
    let readFinished = false;
    let finalDrainHeld = false;
    let releaseDrain: (() => void) | undefined;
    let receivedBytes = 0;
    let expectedBytes = 0;
    const open = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const [filePath, flags] = args;
      if (
        typeof filePath === "string" &&
        path.basename(path.dirname(filePath)).startsWith("worker-workspace-upload-") &&
        path.basename(filePath) === "0" &&
        typeof flags === "number" &&
        (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0
      ) {
        readOpened = true;
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          readFinished = true;
          readClosed.resolve();
        });
      }
      return handle;
    });
    const server = createHttpServer((request, response) => {
      void (async () => {
        expectedBytes = Number(request.headers["content-length"]);
        for await (const chunk of request) {
          receivedBytes += Buffer.byteLength(chunk);
        }
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ manifestRef: f.currentRef }));
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    const gatewayUrl = await listen(server);
    const request = http.request.bind(http);
    const requestSpy = vi.spyOn(http, "request").mockImplementation(((
      url: string | URL,
      options: RequestOptions,
    ) => {
      const address = new URL(url);
      const outgoing = request(url, {
        ...options,
        agent: false,
        createConnection: () => {
          const highWaterMark = getDefaultHighWaterMark(false);
          setDefaultHighWaterMark(false, 1);
          try {
            return connectNet({ host: address.hostname, port: Number(address.port) });
          } finally {
            setDefaultHighWaterMark(false, highWaterMark);
          }
        },
      });
      let submittedBytes = 0;
      let finalWriteBackpressured = false;
      const write = outgoing.write.bind(outgoing);
      vi.spyOn(outgoing, "write").mockImplementation((...args) => {
        const ready = write(...args);
        submittedBytes += Buffer.byteLength(args[0]);
        finalWriteBackpressured =
          !ready && submittedBytes === Number(outgoing.getHeader("content-length"));
        return ready;
      });
      const emit = outgoing.emit.bind(outgoing);
      vi.spyOn(outgoing, "emit").mockImplementation((event, ...args) => {
        if (event === "drain" && finalWriteBackpressured) {
          finalDrainHeld = true;
          releaseDrain = () => {
            emit(event, ...args);
          };
          return true;
        }
        return emit(event, ...args);
      });
      return outgoing;
    }) as typeof http.request);
    try {
      await expect(f.upload(gatewayUrl)).resolves.toBe(f.currentRef);
      expect(receivedBytes).toBe(expectedBytes);
      expect(finalDrainHeld).toBe(true);
      expect(readFinished).toBe(true);
    } finally {
      releaseDrain?.();
      if (readOpened) {
        await readClosed.promise;
      }
      openSpy.mockRestore();
      requestSpy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it.each([
    "rejection",
    "early success",
    "writer failure",
    "writer failure after headers",
    "cancellation",
  ] as const)("settles the upload writer before cleanup after %s", async (mode) => {
    const f = await uploadFixture(mode === "writer failure" ? "" : "captured result\n");
    const readStarted = createDeferred();
    const releaseRead = createDeferred();
    const readSettled = createDeferred();
    const writerAborted = createDeferred();
    const controller = new AbortController();
    const readInterruption = new Error("controlled staged read interruption");
    const lateRequestErrors: Error[] = [];
    const requests: Array<{
      outgoing: http.ClientRequest;
      closed: boolean;
      initialErrorListeners: ReturnType<http.ClientRequest["listeners"]>;
    }> = [];
    let responseConsumed = false;
    let snapshotPresentWhenReadSettled = false;
    let readClosed = false;
    let stagedPath = "";
    let readSignal: AbortSignal | undefined;
    let heldResponse: http.ServerResponse | undefined;
    let rejected: Promise<void> | undefined;
    const onReadAbort = () => {
      releaseRead.resolve();
      writerAborted.resolve();
    };
    const open = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const [filePath, flags] = args;
      if (
        typeof filePath === "string" &&
        path.basename(path.dirname(filePath)).startsWith("worker-workspace-upload-") &&
        path.basename(filePath) === "0" &&
        typeof flags === "number" &&
        (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0
      ) {
        stagedPath = filePath;
        const createReadStream = handle.createReadStream.bind(handle);
        vi.spyOn(handle, "createReadStream").mockImplementation((options) => {
          readSignal = options?.signal;
          readSignal?.addEventListener("abort", onReadAbort, { once: true });
          if (readSignal?.aborted) {
            releaseRead.resolve();
          }
          return createReadStream(options);
        });
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
          await read(...readArgs);
          readStarted.resolve();
          try {
            await releaseRead.promise;
            snapshotPresentWhenReadSettled = await fs.stat(filePath).then(
              (stats) => stats.isFile(),
              () => false,
            );
            throw readInterruption;
          } finally {
            readSettled.resolve();
          }
        });
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          readClosed = true;
        });
      }
      return handle;
    });
    const server = createHttpServer((_request, response) => {
      void readStarted.promise.then(() => {
        if (mode === "cancellation") {
          controller.abort(new Error("controlled upload cancellation"));
          return;
        }
        response.writeHead(mode === "rejection" ? 413 : 200, {
          "content-type": "application/json",
        });
        if (mode === "writer failure after headers") {
          heldResponse = response;
          response.flushHeaders();
          return;
        }
        response.end(
          JSON.stringify(
            mode === "rejection"
              ? { error: "workspace_transfer_limit" }
              : { manifestRef: f.currentRef },
          ),
        );
      });
    });
    const gatewayUrl = await listen(server);
    const request = http.request.bind(http);
    const requestSpy = vi.spyOn(http, "request").mockImplementation(((
      url: string | URL,
      options: RequestOptions,
    ) => {
      const outgoing = request(url, options);
      const observed = {
        outgoing,
        closed: false,
        initialErrorListeners: outgoing.listeners("error"),
      };
      requests.push(observed);
      outgoing.once("close", () => {
        observed.closed = true;
      });
      outgoing.on(errorMonitor, (error: Error) => lateRequestErrors.push(error));
      outgoing.once("response", (response) => {
        if (mode === "writer failure after headers") {
          releaseRead.resolve();
        }
        response.once("end", () => {
          responseConsumed = true;
          if (mode === "writer failure") {
            releaseRead.resolve();
          }
        });
      });
      return outgoing;
    }) as typeof http.request);
    try {
      const operation = f
        .upload(gatewayUrl, mode === "cancellation" ? controller.signal : undefined)
        .finally(() => releaseRead.resolve());
      rejected = expect(operation).rejects.toMatchObject(
        mode === "rejection"
          ? {
              message: "workspace-transfer-limit: gateway rejected workspace transfer caps",
            }
          : {
              message: "workspace-transfer-failed: transfer did not complete",
              stage: mode === "cancellation" ? "reconcile" : "acknowledgement",
              ...(mode === "writer failure" || mode === "writer failure after headers"
                ? { cause: readInterruption }
                : {}),
            },
      );
      if (mode === "writer failure after headers") {
        await writerAborted.promise;
        expect(readSignal?.reason).toBe(readInterruption);
        expect(requests[0]?.outgoing.destroyed).toBe(true);
      }
      await rejected;
      await readSettled.promise;
      expect(snapshotPresentWhenReadSettled).toBe(true);
      expect(readClosed).toBe(true);
      await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(responseConsumed).toBe(
        mode !== "cancellation" && mode !== "writer failure after headers",
      );
      for (const observed of requests) {
        expect(observed.closed).toBe(true);
        expect(
          observed.outgoing
            .listeners("error")
            .filter((listener) => !observed.initialErrorListeners.includes(listener)),
        ).toEqual([]);
      }
      if (mode === "writer failure after headers") {
        expect(lateRequestErrors).toEqual([readInterruption]);
      } else if (mode !== "cancellation") {
        expect(lateRequestErrors).toEqual([]);
      }
    } finally {
      heldResponse?.end(JSON.stringify({ manifestRef: f.currentRef }));
      releaseRead.resolve();
      await rejected?.catch(() => {});
      if (stagedPath) {
        await readSettled.promise;
      }
      readSignal?.removeEventListener("abort", onReadAbort);
      openSpy.mockRestore();
      requestSpy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
