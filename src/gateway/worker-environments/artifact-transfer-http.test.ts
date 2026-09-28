import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createGatewayAuthRateLimiter, type AuthRateLimiter } from "../auth-rate-limit.js";
import { createArtifactTransferHttpCallback } from "./artifact-transfer-http.js";
import {
  ArtifactTransferBusyError,
  createArtifactTransferService,
  type ArtifactTransferService,
} from "./artifact-transfer-service.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap.js";
import { handleWorkerBootstrapArtifactTransferHttpRequest } from "./worker-bootstrap-artifact-transfer-http.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

describe("artifact transfer response settlement", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const contents = "source-runtime";
  let service: ReturnType<typeof createWorkerBootstrapArtifactTransferService>;
  let artifact: { tarballPath: string; tarballSha256: string; tarballBytes: number };
  let token: string;
  let expiresAtMs: number;
  let now: number;
  let authorized: boolean;
  let owner: AbortController;
  let rateLimiter: AuthRateLimiter | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    now = 1_000;
    authorized = true;
    owner = new AbortController();
    service = createWorkerBootstrapArtifactTransferService({ now: () => now });
    await prepareArtifact(contents);
  });

  async function prepareArtifact(bytes: string | Buffer) {
    artifact = {
      tarballPath: path.join(tempDirs.make("openclaw-artifact-response-"), "runtime.tgz"),
      tarballSha256: createHash("sha256").update(bytes).digest("hex"),
      tarballBytes: Buffer.byteLength(bytes),
    };
    await fs.writeFile(artifact.tarballPath, bytes);
    ({ token, expiresAtMs } = service.prepare({
      artifact,
      isAuthorized: () => authorized,
      signal: owner.signal,
    }));
  }

  afterEach(() => {
    service.closeAll();
    rateLimiter?.dispose();
    rateLimiter = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function serve(
    options: {
      writeError?: Error;
      artifactKey?: string;
      range?: string;
      afterWrite?: () => void;
      transfer?: Omit<ArtifactTransferService, "prepare">;
    } = {},
  ) {
    const chunks: Buffer[] = [];
    class ResponseSocket extends Socket {
      override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
        chunks.push(Buffer.from(chunk));
        options.afterWrite?.();
        callback(options.writeError);
      }
      override _writev(writes: Array<{ chunk: Buffer }>, callback: (error?: Error) => void) {
        chunks.push(...writes.map(({ chunk }) => Buffer.from(chunk)));
        options.afterWrite?.();
        callback(options.writeError);
      }
    }
    const socket = new ResponseSocket();
    socket.on("error", () => {});
    const req = new IncomingMessage(socket);
    req.method = "GET";
    req.url = `/__openclaw__/worker-bootstrap/artifacts/${options.artifactKey ?? artifact.tarballSha256}`;
    req.headers.authorization = `Bearer ${token}`;
    if (options.range !== undefined) {
      req.headers.range = options.range;
    }
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    try {
      await handleWorkerBootstrapArtifactTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback: createArtifactTransferHttpCallback(options.transfer ?? service),
        rateLimiter,
      });
      const wire = Buffer.concat(chunks).toString("utf8");
      return { res, wire, body: wire.slice(wire.indexOf("\r\n\r\n") + 4) };
    } finally {
      socket.destroy();
    }
  }

  it("reports progress only for authorized bytes and isolates observer failures", async ({
    onTestFinished,
  }) => {
    const transfer = createArtifactTransferService({ now: () => now });
    onTestFinished(() => transfer.closeAll());
    const onProgress = vi.fn(() => {
      throw new Error("synthetic progress observer failure");
    });
    const prepare = () =>
      transfer.prepare({
        artifact,
        artifactKey: artifact.tarballSha256,
        ttlMs: 60_000,
        maxServes: 1,
        isAuthorized: () => authorized,
        onProgress,
      });
    ({ token } = prepare());
    transfer.revoke(token);
    expect((await serve({ transfer })).res.statusCode).toBe(404);
    expect(onProgress).not.toHaveBeenCalled();

    ({ token } = prepare());
    const completed = await serve({ transfer });
    expect(completed.res.statusCode).toBe(200);
    expect(completed.res.writableFinished).toBe(true);
    expect(completed.body).toBe(contents);
    expect(onProgress).toHaveBeenCalled();
  });

  it.each([0, 4, contents.length - 1])(
    "serves exactly the bytes from offset %i",
    async (offset) => {
      const { res, body } = await serve({ range: `bytes=${offset}-` });
      expect(res.statusCode).toBe(206);
      expect(res.getHeader("content-range")).toBe(
        `bytes ${offset}-${artifact.tarballBytes - 1}/${artifact.tarballBytes}`,
      );
      expect(res.getHeader("content-length")).toBe(String(artifact.tarballBytes - offset));
      expect(res.getHeader("x-openclaw-content-sha256")).toBe(artifact.tarballSha256);
      expect(res.getHeader("accept-ranges")).toBe("bytes");
      expect(body).toBe(contents.slice(offset));
    },
  );

  it.each([
    "bytes=0-,4-",
    "bytes=-4",
    "bytes=0-4",
    "bytes=-1-",
    "bytes=1.5-",
    "bytes=9007199254740992-",
    `bytes=${contents.length}-`,
    `bytes=${contents.length + 1}-`,
    "items=0-",
    "",
  ])("rejects unsupported or unsatisfiable range %j", async (range) => {
    const { res, body } = await serve({ range });
    expect(res.statusCode).toBe(416);
    expect(res.getHeader("content-range")).toBe(`bytes */${artifact.tarballBytes}`);
    expect(JSON.parse(body)).toEqual({ error: "range_not_satisfiable" });
  });

  it("terminates a ranged response when its capability is revoked mid-stream", async () => {
    await prepareArtifact(Buffer.alloc(256 * 1024, "x"));
    const offset = 1024;
    const { res, body } = await serve({
      range: `bytes=${offset}-`,
      afterWrite: () => service.revoke(token),
    });
    expect(res.statusCode).toBe(206);
    expect(res.writableFinished).toBe(false);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThan(artifact.tarballBytes - offset);
    expect((await serve({ range: `bytes=${offset + body.length}-` })).res.statusCode).toBe(404);
  });

  it("counts interrupted serves and keeps retries exclusive through descriptor settlement", async () => {
    rateLimiter = createGatewayAuthRateLimiter(
      { maxAttempts: 1, exemptLoopback: false, pruneIntervalMs: 0 },
      { scheduler: createTestGatewayScheduler() },
    );
    const closing = createDeferredCore();
    const release = createDeferredCore();
    const open = service.openFile.bind(service);
    vi.spyOn(service, "openFile").mockImplementationOnce(async (authorization) => {
      const file = await open(authorization);
      if (!file) {
        throw new Error("Expected an authorized artifact");
      }
      const close = file.handle.close.bind(file.handle);
      vi.spyOn(file.handle, "close").mockImplementationOnce(async () => {
        closing.resolve();
        await release.promise;
        await close();
      });
      return file;
    });
    const interrupted = serve({ writeError: new Error("synthetic connection reset") });
    try {
      await closing.promise;
      expect((await serve({ range: "bytes=4-" })).res.statusCode).toBe(503);
    } finally {
      release.resolve();
      await interrupted;
    }
    expect((await interrupted).res.writableFinished).toBe(false);
    for (let attempt = 2; attempt <= 3; attempt++) {
      const completed = await serve({ range: "bytes=4-" });
      expect(completed.res.statusCode).toBe(206);
      expect(completed.res.writableFinished).toBe(true);
      expect(completed.body).toBe(contents.slice(4));
    }
    expect((await serve({ range: "bytes=4-" })).res.statusCode).toBe(404);
  });

  it("allows three completed serves for buffering proxies, then rejects the token", async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const completed = await serve();
      expect(completed.res.statusCode).toBe(200);
      expect(completed.res.writableFinished).toBe(true);
      expect(completed.wire.endsWith(contents)).toBe(true);
    }
    expect((await serve()).res.statusCode).toBe(404);
  });

  it("fences stale attempts and retains the original retry deadline", async () => {
    const request = { token, artifactKey: artifact.tarballSha256 };
    const first = service.authorize(request)!;
    expect(() => service.authorize(request)).toThrow(ArtifactTransferBusyError);
    now = expiresAtMs - 1;
    service.finish(first);
    expect(service.authorizationSignal(first).aborted).toBe(true);
    const replacement = service.authorize(request)!;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(first);
    service.finish(first);
    service.revoke(first);
    await expect(service.openFile(first)).resolves.toBeNull();
    expect(service.isAuthorizationCurrent(replacement)).toBe(true);
    service.finish(replacement);
    now = expiresAtMs;
    expect(service.authorize(request)).toBeUndefined();
    now = 1_000;
    expect(service.authorize(request)).toBeUndefined();
  });

  it.each(["expiry", "owner", "signal"] as const)(
    "streams past ten minutes until bootstrap %s closes its authority",
    async (closure) => {
      const deadline = now + workerBootstrapOperationTimeoutMs(artifact);
      const afterTenMinutes = now + 10 * 60_000 + 1;
      const open = service.openFile.bind(service);
      const observations: boolean[] = [];
      vi.spyOn(service, "openFile").mockImplementationOnce(async (authorization) => {
        const file = await open(authorization);
        if (!file) {
          throw new Error("Expected an authorized artifact");
        }
        const signal = service.authorizationSignal(authorization);
        const createReadStream = file.handle.createReadStream.bind(file.handle);
        vi.spyOn(file.handle, "createReadStream").mockImplementationOnce((options) => {
          const stream = createReadStream({ ...options, highWaterMark: 1 });
          stream.on("data", () => {
            if (observations.length === 0) {
              now += 10 * 60_000 + 1;
              vi.advanceTimersByTime(10 * 60_000 + 1);
              observations.push(!signal.aborted && service.isAuthorizationCurrent(authorization));
            } else if (observations.length === 1) {
              if (closure === "expiry") {
                const remaining = deadline - now - 1;
                now += remaining;
                vi.advanceTimersByTime(remaining);
              }
              observations.push(!signal.aborted && service.isAuthorizationCurrent(authorization));
              if (closure === "owner") {
                authorized = false;
              } else if (closure === "signal") {
                owner.abort();
              }
            } else if (closure === "expiry") {
              now++;
              vi.advanceTimersByTime(1);
            }
          });
          return stream;
        });
        return file;
      });

      const interrupted = await serve();
      expect(observations).toEqual([true, true]);
      expect(expiresAtMs).toBe(deadline);
      expect(interrupted.res.statusCode).toBe(200);
      expect(interrupted.wire.split("\r\n\r\n")[1]).toBe(
        contents.slice(0, closure === "expiry" ? 2 : 1),
      );
      expect(interrupted.res.writableFinished).toBe(false);
      expect(interrupted.res.destroyed).toBe(true);
      expect(now).toBe(closure === "expiry" ? deadline : afterTenMinutes);
      expect(owner.signal.aborted).toBe(closure === "signal");
      authorized = true;
      const rejected = await serve();
      expect(rejected.res.statusCode).toBe(404);
      expect(rejected.wire).toContain('{"error":"not_found"}');
    },
  );

  it.each(["owner", "expiry", "signal"] as const)(
    "keeps busy artifact identity opaque and rejects %s closure",
    async (closure) => {
      service.authorize({ token, artifactKey: artifact.tarballSha256 });
      expect((await serve({ artifactKey: "0".repeat(64) })).res.statusCode).toBe(404);
      expect((await serve()).res.statusCode).toBe(503);
      if (closure === "owner") {
        authorized = false;
      } else if (closure === "expiry") {
        now = expiresAtMs;
      } else {
        owner.abort();
      }
      expect((await serve()).res.statusCode).toBe(404);
    },
  );

  it.each(["owner", "signal", "revoke", "shutdown"] as const)(
    "never reopens an interrupted transfer after %s closure",
    (closure) => {
      const request = { token, artifactKey: artifact.tarballSha256 };
      const admission = service.authorize(request)!;
      if (closure === "owner") {
        authorized = false;
      } else if (closure === "signal") {
        owner.abort();
      } else if (closure === "revoke") {
        service.revoke(token);
      } else {
        service.closeAll();
      }
      service.finish(admission);
      expect(service.authorizationSignal(admission).aborted).toBe(true);
      authorized = true;
      expect(service.authorize(request)).toBeUndefined();
    },
  );
});
