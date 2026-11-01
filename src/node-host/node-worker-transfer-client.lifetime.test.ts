import { errorMonitor } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http, { createServer as createHttpServer, type RequestOptions } from "node:http";
import { connect as connectNet } from "node:net";
import path from "node:path";
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest-worker.js";
import {
  closeServer,
  manifestFixture,
  transferFixture,
  transferHandler,
  writeManifest,
} from "./node-worker-transfer-client.fixture.test-support.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function uploadFixture(content: string | Buffer) {
  const root = tempDirs.make("node-worker-transfer-lifetime-");
  const { workspaceDir, upload } = transferFixture(root, "environment-upload-lifetime");
  await fs.mkdir(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "result.txt"), content);
  const currentRef = (await captureWorkspaceManifest({ root: workspaceDir, baseCommit: null }))
    .manifestRef;
  const { rawManifest, manifestRef } = manifestFixture();
  await writeManifest(root, rawManifest);
  return {
    currentRef,
    upload: (gatewayUrl: string, signal?: AbortSignal) =>
      upload(gatewayUrl, manifestRef, { signal }),
  };
}

function observeStagedReads(
  observe?: (handle: fs.FileHandle, filePath: string) => void | Promise<void>,
) {
  const state = { path: "", closed: false, finished: createDeferred() };
  const open = fs.open.bind(fs);
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const [filePath, flags] = args;
    if (
      typeof filePath === "string" &&
      path.basename(path.dirname(filePath)).startsWith("worker-workspace-upload-") &&
      path.basename(filePath) === "0" &&
      typeof flags === "number" &&
      (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0
    ) {
      state.path = filePath;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        state.closed = true;
        state.finished.resolve();
      });
      await observe?.(handle, filePath);
    }
    return handle;
  });
  return Object.assign(spy, { state });
}

describe("node worker upload HTTP lifetime", () => {
  it("cancels before streaming a staged file whose open outlives its caller", async ({
    signal,
  }) => {
    const f = await uploadFixture("captured result\n");
    const controller = new AbortController();
    const readOpened = createDeferred();
    const releaseOpen = createDeferred();
    const createReadStream = vi.fn();
    const openSpy = observeStagedReads(async (handle) => {
      const stream = handle.createReadStream.bind(handle);
      vi.spyOn(handle, "createReadStream").mockImplementation((options) => {
        createReadStream();
        return stream(options);
      });
      readOpened.resolve();
      await releaseOpen.promise;
    });
    const server = createHttpServer();
    const gatewayUrl = await listen(server);
    const operation = f.upload(gatewayUrl, controller.signal);
    const rejected = expect(operation).rejects.toMatchObject({
      operation: "upload",
      stage: "reconcile",
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          readOpened.promise,
          operation,
          "Upload settled before staged-file open",
        ),
        signal,
      );
      controller.abort(new Error("upload cancelled while opening its staged file"));
      releaseOpen.resolve();
      await withinTest(rejected, signal);
      expect(createReadStream).not.toHaveBeenCalled();
      expect(openSpy.state.closed).toBe(true);
      await expect(fs.stat(openSpy.state.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseOpen.resolve();
      await operation.catch(() => undefined);
      openSpy.mockRestore();
      await closeServer(server);
    }
  });

  it("accepts a complete response before the final backpressure drain", async () => {
    const f = await uploadFixture(Buffer.alloc(2 * 1024 * 1024, "a"));
    let finalDrainHeld = false;
    let releaseDrain: (() => void) | undefined;
    let receivedBytes = 0;
    let expectedBytes = 0;
    const openSpy = observeStagedReads();
    const server = createHttpServer(
      transferHandler(async (request, response) => {
        expectedBytes = Number(request.headers["content-length"]);
        for await (const chunk of request) {
          receivedBytes += Buffer.byteLength(chunk);
        }
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ manifestRef: f.currentRef }));
      }),
    );
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
      expect(openSpy.state.closed).toBe(true);
    } finally {
      releaseDrain?.();
      if (openSpy.state.path) {
        await openSpy.state.finished.promise;
      }
      openSpy.mockRestore();
      requestSpy.mockRestore();
      await closeServer(server);
    }
  });

  it.each([
    "rejection",
    "early success",
    "writer failure",
    "writer failure after headers",
    "cancellation",
  ] as const)("settles the upload writer before cleanup after %s", async (mode) => {
    const cancelled = mode === "cancellation";
    const headersHeld = mode === "writer failure after headers";
    const writerFails = mode.startsWith("writer failure");
    const f = await uploadFixture(mode === "writer failure" ? "" : "captured result\n");
    const readStarted = createDeferred();
    const releaseRead = createDeferred();
    const readSettled = createDeferred();
    const writerAborted = createDeferred();
    const controller = new AbortController();
    const readInterruption = new Error("controlled staged read interruption");
    const lateRequestErrors: Error[] = [];
    const requests = new Map<http.ClientRequest, ReturnType<http.ClientRequest["listeners"]>>();
    let responseConsumed = false;
    let snapshotPresentWhenReadSettled = false;
    let readSignal: AbortSignal | undefined;
    let heldResponse: http.ServerResponse | undefined;
    let rejected: Promise<void> | undefined;
    const onReadAbort = () => {
      releaseRead.resolve();
      writerAborted.resolve();
    };
    const openSpy = observeStagedReads((handle, filePath) => {
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
    });
    const server = createHttpServer((_request, response) => {
      void readStarted.promise.then(() => {
        if (cancelled) {
          controller.abort(new Error("controlled upload cancellation"));
          return;
        }
        response.writeHead(mode === "rejection" ? 413 : 200, {
          "content-type": "application/json",
        });
        if (headersHeld) {
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
      requests.set(outgoing, outgoing.listeners("error"));
      outgoing.on(errorMonitor, (error: Error) => lateRequestErrors.push(error));
      outgoing.once("response", (response) => {
        if (headersHeld) {
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
        .upload(gatewayUrl, cancelled ? controller.signal : undefined)
        .finally(() => releaseRead.resolve());
      rejected = expect(operation).rejects.toMatchObject(
        mode === "rejection"
          ? {
              message: "workspace-transfer-limit: gateway rejected workspace transfer caps",
            }
          : {
              message: "workspace-transfer-failed: transfer did not complete",
              operation: "upload",
              stage: cancelled ? "reconcile" : "acknowledgement",
              ...(writerFails ? { cause: readInterruption } : {}),
            },
      );
      if (headersHeld) {
        await writerAborted.promise;
        expect(readSignal?.reason).toBe(readInterruption);
        expect(requests.keys().next().value?.destroyed).toBe(true);
      }
      await rejected;
      await readSettled.promise;
      expect(snapshotPresentWhenReadSettled).toBe(true);
      expect(openSpy.state.closed).toBe(true);
      await expect(fs.stat(openSpy.state.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(responseConsumed).toBe(!cancelled && !headersHeld);
      for (const [outgoing, initialErrorListeners] of requests) {
        expect(outgoing.closed).toBe(true);
        expect(
          outgoing
            .listeners("error")
            .filter((listener) => !initialErrorListeners.includes(listener)),
        ).toEqual([]);
      }
      if (headersHeld) {
        expect(lateRequestErrors).toEqual([readInterruption]);
      } else if (!cancelled) {
        expect(lateRequestErrors).toEqual([]);
      }
    } finally {
      heldResponse?.end(JSON.stringify({ manifestRef: f.currentRef }));
      releaseRead.resolve();
      await rejected?.catch(() => {});
      if (openSpy.state.path) {
        await readSettled.promise;
      }
      readSignal?.removeEventListener("abort", onReadAbort);
      openSpy.mockRestore();
      requestSpy.mockRestore();
      await closeServer(server);
    }
  });
});
