import { createHash } from "node:crypto";
import type { ReadStream } from "node:fs";
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
import { workerBootstrapOperationTimeoutMs } from "./bootstrap-timeouts.js";
import { handleWorkerBootstrapArtifactTransferHttpRequest } from "./worker-bootstrap-artifact-transfer-http.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

type ResponseOptions = { writeError?: Error; afterWrite?: () => void };

// Exercise real HTTP response/stream completion without binding a listener.
class ResponseSocket extends Socket {
  readonly chunks: Buffer[] = [];

  constructor(private readonly options: ResponseOptions = {}) {
    super();
  }

  override _read() {
    // This sink has no peer or inbound bytes.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.chunks.push(Buffer.from(chunk));
    this.options.afterWrite?.();
    callback(this.options.writeError);
  }

  override _writev(writes: Array<{ chunk: Buffer }>, callback: (error?: Error) => void) {
    this.chunks.push(...writes.map(({ chunk }) => Buffer.from(chunk)));
    this.options.afterWrite?.();
    callback(this.options.writeError);
  }
}

function createResponse(options?: ResponseOptions) {
  const socket = new ResponseSocket(options);
  const socketErrors = vi.fn<(error: Error) => void>();
  socket.on("error", socketErrors);
  const req = new IncomingMessage(socket);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  return { socket, socketErrors, req, res };
}

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
    options: ResponseOptions & {
      artifactKey?: string;
      range?: string;
      transfer?: Omit<ArtifactTransferService, "prepare">;
    } = {},
  ) {
    const { socket, req, res } = createResponse(options);
    req.method = "GET";
    req.url = `/__openclaw__/worker-bootstrap/artifacts/${options.artifactKey ?? artifact.tarballSha256}`;
    req.headers.authorization = `Bearer ${token}`;
    if (options.range !== undefined) {
      req.headers.range = options.range;
    }
    try {
      await handleWorkerBootstrapArtifactTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback: createArtifactTransferHttpCallback(options.transfer ?? service),
        rateLimiter,
      });
      const wire = Buffer.concat(socket.chunks).toString("utf8");
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

  it("allows five interrupted resumes and keeps retries exclusive through descriptor settlement", async () => {
    rateLimiter = createGatewayAuthRateLimiter(
      { maxAttempts: 1, exemptLoopback: false, pruneIntervalMs: 0 },
      { scheduler: createTestGatewayScheduler() },
    );
    const closing = createDeferredCore();
    const release = createDeferredCore();
    const open = service.openFile.bind(service);
    vi.spyOn(service, "openFile").mockImplementation(async (authorization) => {
      const file = await open(authorization);
      if (!file) {
        throw new Error("Expected an authorized artifact");
      }
      const createReadStream = file.handle.createReadStream.bind(file.handle);
      vi.spyOn(file.handle, "createReadStream").mockImplementation((options) =>
        createReadStream({ ...options, highWaterMark: 1 }),
      );
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
    let received = (await interrupted).body;
    for (let attempt = 2; attempt <= 5; attempt++) {
      const resumed = await serve({
        range: `bytes=${received.length}-`,
        writeError: new Error("synthetic connection reset"),
      });
      expect(resumed.res.statusCode).toBe(206);
      expect(resumed.res.writableFinished).toBe(false);
      expect(resumed.body).toBe(contents.slice(received.length, received.length + 1));
      received += resumed.body;
    }
    const completed = await serve({ range: `bytes=${received.length}-` });
    expect(completed.res.statusCode).toBe(206);
    expect(completed.res.writableFinished).toBe(true);
    expect(received + completed.body).toBe(contents);
  });

  it("shares the 256-serve budget between full and ranged responses", async () => {
    for (let attempt = 1; attempt <= 256; attempt++) {
      const range = attempt % 2 === 0 ? "bytes=4-" : undefined;
      const completed = await serve({ range });
      expect(completed.res.statusCode).toBe(range ? 206 : 200);
      expect(completed.res.writableFinished).toBe(true);
      expect(completed.body).toBe(range ? contents.slice(4) : contents);
    }
    for (const range of [undefined, "bytes=4-"]) {
      const rejected = await serve({ range });
      expect(rejected.res.statusCode).toBe(404);
      expect(JSON.parse(rejected.body)).toEqual({ error: "not_found" });
    }
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

  it("keeps busy artifact identity opaque and rejects lost authority", async () => {
    service.authorize({ token, artifactKey: artifact.tarballSha256 });
    expect((await serve({ artifactKey: "0".repeat(64) })).res.statusCode).toBe(404);
    expect((await serve()).res.statusCode).toBe(503);
    authorized = false;
    expect((await serve()).res.statusCode).toBe(404);
  });
});

describe("artifact transfer interruption observations", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const services: Array<ReturnType<typeof createArtifactTransferService>> = [];
  const sockets: ResponseSocket[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    for (const service of services.splice(0)) {
      service.closeAll();
    }
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function prepare(onProgress?: (bytes: number) => void, maxServes: 1 | 3 = 1) {
    const tarballPath = path.join(tempDirs.make("openclaw-transfer-interruption-"), "bundle.tgz");
    await fs.writeFile(tarballPath, "bundle");
    const artifactKey = "a".repeat(64);
    const owner = new AbortController();
    let now = 1_000;
    let authorized = true;
    let authorityError: Error | undefined;
    const service = createArtifactTransferService({
      now: () => now,
      generateToken: () => "X".repeat(43),
    });
    services.push(service);
    const progress = vi.fn<(bytes: number) => void>();
    const interrupted = vi.fn<(bytes: number, reason: string) => void>();
    const prepared = service.prepare({
      artifact: { tarballPath, tarballBytes: 6, tarballSha256: "b".repeat(64) },
      artifactKey,
      ttlMs: 1_000,
      maxServes,
      signal: owner.signal,
      isAuthorized: () => {
        if (authorityError) {
          throw authorityError;
        }
        return authorized;
      },
      onProgress: (bytes) => {
        progress(bytes);
        onProgress?.(bytes);
      },
      onInterrupted: interrupted,
    });
    const openFile = service.openFile.bind(service);
    let stream: ReadStream | undefined;
    vi.spyOn(service, "openFile").mockImplementation(async (capability) => {
      const file = await openFile(capability);
      if (file) {
        const createReadStream = file.handle.createReadStream.bind(file.handle);
        vi.spyOn(file.handle, "createReadStream").mockImplementation((options) => {
          stream = createReadStream({ ...options, highWaterMark: 2 });
          return stream;
        });
      }
      return file;
    });
    let response = createResponse();
    sockets.push(response.socket);
    const callback = createArtifactTransferHttpCallback(service);
    return {
      service,
      owner,
      get socket() {
        return response.socket;
      },
      get socketErrors() {
        return response.socketErrors;
      },
      get res() {
        return response.res;
      },
      prepared,
      artifactKey,
      tarballPath,
      progress,
      interrupted,
      failStream: (error: Error) => {
        if (!stream) {
          throw new Error("fixture stream has not started");
        }
        stream.destroy(error);
      },
      loseAuthority: (error?: Error) => {
        authorized = false;
        authorityError = error;
      },
      restoreAuthority: () => {
        authorized = true;
        authorityError = undefined;
      },
      expire: () => {
        now = prepared.expiresAtMs;
      },
      async run(range?: string) {
        if (response.res.destroyed || response.res.writableFinished) {
          response = createResponse();
          sockets.push(response.socket);
        }
        const { req, res } = response;
        if (range !== undefined) {
          req.headers.range = range;
        }
        const admission = await callback({ req, res, artifactKey, bearer: prepared.token });
        if (admission.kind !== "authorized") {
          throw new Error("fixture artifact was not authorized");
        }
        await admission.handle();
      },
    };
  }

  it.each([
    "expired",
    "owner cancelled",
    "authorization lost",
    "throwing authorization",
    "released",
    "shutdown",
  ] as const)("reports partial transfer closure for %s", async (closure) => {
    const h = await prepare(() => {
      if (closure === "expired") {
        h.expire();
      } else if (closure === "owner cancelled") {
        h.owner.abort(new Error("private cancellation detail"));
      } else if (closure === "authorization lost" || closure === "throwing authorization") {
        h.loseAuthority(
          closure === "throwing authorization" ? new Error("private error") : undefined,
        );
      } else if (closure === "released") {
        h.service.revoke(h.prepared.token);
      } else {
        h.service.closeAll();
      }
    }, 3);
    await h.run();
    expect(h.interrupted).toHaveBeenCalledExactlyOnceWith(
      2,
      `authority closed (${closure === "throwing authorization" ? "authorization lost" : closure})`,
    );
    expect(h.socketErrors).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "ABORT_ERR" }),
    );
    h.restoreAuthority();
    expect(
      h.service.authorize({ token: h.prepared.token, artifactKey: h.artifactKey }),
    ).toBeUndefined();
  });

  it("records timer expiry independently of a later owner cancellation", async () => {
    const h = await prepare();
    const admission = h.service.authorize({ token: h.prepared.token, artifactKey: h.artifactKey });
    expect(admission).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    h.owner.abort();
    h.service.revoke(admission!);
    expect(admission?.capability.revocationReason).toBe("expired");
    expect(h.service.authorizationSignal(admission!).aborted).toBe(true);
  });

  it("reports a partial client disconnect once and isolates a throwing observer", async () => {
    const h = await prepare(() => h.socket.destroy());
    h.interrupted.mockImplementation(() => {
      throw new Error("observer unavailable");
    });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.interrupted).toHaveBeenCalledExactlyOnceWith(2, "client disconnected");
    expect(h.socketErrors).not.toHaveBeenCalled();
    expect(
      h.service.authorize({ token: h.prepared.token, artifactKey: h.artifactKey }),
    ).toBeUndefined();
  });

  it.each([
    { range: undefined, status: 200, progress: [2, 4, 6] },
    { range: "bytes=2-", status: 206, progress: [4, 6] },
  ])(
    "reports completed progress without interruption for $status",
    async ({ range, status, progress }) => {
      const h = await prepare();
      await h.run(range);
      h.socket.destroy();
      h.owner.abort();
      expect(h.res.statusCode).toBe(status);
      expect(h.progress.mock.calls.flat()).toEqual(progress);
      expect(h.res.writableFinished).toBe(true);
      expect(h.interrupted).not.toHaveBeenCalled();
      expect(h.socketErrors).not.toHaveBeenCalled();
    },
  );

  it("retains observers across interrupted and completed retries with per-serve byte counts", async () => {
    let firstServe = true;
    const h = await prepare((bytes) => {
      if (firstServe && bytes === 4) {
        firstServe = false;
        h.failStream(new Error("synthetic read failure"));
      }
    }, 3);
    await h.run();
    expect(h.interrupted).toHaveBeenCalledExactlyOnceWith(
      4,
      "stream error (synthetic read failure)",
    );
    expect(h.res.writableFinished).toBe(false);
    await h.run();
    expect(h.res.writableFinished).toBe(true);
    await h.run();
    expect(h.res.writableFinished).toBe(true);
    expect(h.progress.mock.calls.flat()).toEqual([2, 4, 2, 4, 6, 2, 4, 6]);
    expect(h.interrupted).toHaveBeenCalledOnce();
    expect(
      h.service.authorize({ token: h.prepared.token, artifactKey: h.artifactKey }),
    ).toBeUndefined();
  });

  it("keeps the stream error cause bounded and free of paths and bearers", async () => {
    const h = await prepare(() => {
      h.failStream(
        new Error(
          `read failed: ${h.tarballPath}; bearer=${h.prepared.token}; ` +
            "unix=/private/other/runtime.tgz win=C:\\private\\other\\runtime.tgz " +
            'quoted="/private/path with spaces/runtime.tgz" url=https://private.test/bundle ' +
            'relative=../private/runtime.tgz bare=private/runtime.tgz quotedRelative="private dir/runtime.tgz" ' +
            `\n${"terminal diagnostic ".repeat(200)}`,
        ),
      );
    });
    await h.run();
    expect(h.interrupted).toHaveBeenCalledOnce();
    expect(h.socketErrors).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining("read failed:") }),
    );
    const [bytes, reason] = h.interrupted.mock.calls[0]!;
    expect(bytes).toBe(2);
    expect(reason).toContain("stream error (read failed:");
    expect(reason).not.toContain(h.prepared.token);
    expect(reason).not.toContain(h.tarballPath);
    expect(reason).not.toContain("private");
    expect(reason).not.toContain("runtime.tgz");
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThanOrEqual(256);
  });
});
