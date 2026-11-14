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
import {
  classifyWorkerBootstrapArtifactTransferPath,
  WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH,
} from "../gateway-http-route-contracts.js";
import {
  createArtifactTransferHttpCallback,
  handleArtifactTransferHttpRequest,
} from "./artifact-transfer-http.js";
import {
  ArtifactTransferBusyError,
  createArtifactTransferService,
  type ArtifactTransferService,
} from "./artifact-transfer-service.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap-timeouts.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

type ResponseOptions = { writeError?: Error; afterWrite?: () => void };
type Authorization = Parameters<ArtifactTransferService["openFile"]>[0];
type OpenFile = NonNullable<Awaited<ReturnType<ArtifactTransferService["openFile"]>>>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const services: Array<Pick<ArtifactTransferService, "closeAll">> = [];
const sockets: ResponseSocket[] = [];

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  services.splice(0).forEach((service) => service.closeAll());
  sockets.splice(0).forEach((socket) => socket.destroy());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
  sockets.push(socket);
  const socketErrors = vi.fn<(error: Error) => void>();
  socket.on("error", socketErrors);
  const req = new IncomingMessage(socket);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  return { socket, socketErrors, req, res };
}

function interceptFile(
  service: Pick<ArtifactTransferService, "openFile">,
  size: number,
  configure: (stream: ReadStream, authorization: Authorization, file: OpenFile) => void,
  once = false,
  required = true,
) {
  const open = service.openFile.bind(service);
  const spy = vi.spyOn(service, "openFile");
  const intercept = async (authorization: Authorization) => {
    const file = await open(authorization);
    if (file) {
      const create = file.handle.createReadStream.bind(file.handle);
      vi.spyOn(file.handle, "createReadStream")[
        once ? "mockImplementationOnce" : "mockImplementation"
      ]((options) => {
        const stream = create({ ...options, highWaterMark: size });
        configure(stream, authorization, file);
        return stream;
      });
    } else if (required) {
      throw new Error("Expected an authorized artifact");
    }
    return file;
  };
  spy[once ? "mockImplementationOnce" : "mockImplementation"](intercept);
}

function responseBytes(socket: ResponseSocket) {
  const wire = Buffer.concat(socket.chunks).toString("utf8");
  const boundary = wire.indexOf("\r\n\r\n");
  return { wire, body: wire.slice(boundary + 4), headers: wire.slice(0, boundary).split("\r\n") };
}

async function makeArtifact(bytes: string | Buffer, sha256?: string) {
  const tarballPath = path.join(tempDirs.make("openclaw-artifact-response-"), "runtime.tgz");
  await fs.writeFile(tarballPath, bytes);
  return {
    tarballPath,
    tarballBytes: Buffer.byteLength(bytes),
    tarballSha256: sha256 ?? createHash("sha256").update(bytes).digest("hex"),
  };
}

function expectResponse(
  response: { res: ServerResponse; body: string },
  statusCode: number,
  body: string,
  writableFinished = true,
) {
  expect(response).toMatchObject({ res: { statusCode, writableFinished }, body });
}

describe("artifact transfer response settlement", () => {
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
    now = 1_000;
    authorized = true;
    owner = new AbortController();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    service = createWorkerBootstrapArtifactTransferService();
    services.push(service);
    await prepareArtifact(contents);
  });

  async function prepareArtifact(bytes: string | Buffer) {
    artifact = await makeArtifact(bytes);
    ({ token, expiresAtMs } = service.prepare({
      artifact,
      isAuthorized: () => authorized,
      signal: owner.signal,
    }));
  }

  afterEach(() => {
    rateLimiter?.dispose();
    rateLimiter = undefined;
  });

  async function serve(
    options: ResponseOptions & {
      artifactKey?: string;
      range?: string;
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
      await handleArtifactTransferHttpRequest({
        classifyPath: classifyWorkerBootstrapArtifactTransferPath,
        routePrefix: `${WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH}/artifacts/`,
        req,
        res,
        clientIp: "127.0.0.1",
        callback: createArtifactTransferHttpCallback(service),
        rateLimiter,
      });
      return { res, ...responseBytes(socket) };
    } finally {
      socket.destroy();
    }
  }

  it.each(["bytes=0-,4-", "bytes=9007199254740992-", `bytes=${contents.length}-`])(
    "rejects unsupported or unsatisfiable range %j",
    async (range) => {
      const { res, body } = await serve({ range });
      expect(res.statusCode).toBe(416);
      expect(res.getHeader("content-range")).toBe(`bytes */${artifact.tarballBytes}`);
      expect(JSON.parse(body)).toEqual({ error: "range_not_satisfiable" });
    },
  );

  it("terminates a ranged response when its capability is revoked mid-stream", async () => {
    await prepareArtifact(Buffer.alloc(256 * 1024, "x"));
    const offset = 1024;
    const { res, body } = await serve({
      range: `bytes=${offset}-`,
      afterWrite: () => service.revoke(token),
    });
    expect(res).toMatchObject({ statusCode: 206, writableFinished: false });
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
    interceptFile(service, 1, (_stream, _authorization, file) => {
      const close = file.handle.close.bind(file.handle);
      vi.spyOn(file.handle, "close").mockImplementationOnce(async () => {
        closing.resolve();
        await release.promise;
        await close();
      });
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
      expectResponse(resumed, 206, contents.slice(received.length, received.length + 1), false);
      received += resumed.body;
    }
    const completed = await serve({ range: `bytes=${received.length}-` });
    expect(completed.res).toMatchObject({ statusCode: 206, writableFinished: true });
    expect(received + completed.body).toBe(contents);
  });

  it("shares the 256-serve budget between full and ranged responses", async () => {
    for (let attempt = 1; attempt <= 256; attempt++) {
      const range = attempt % 2 === 0 ? "bytes=4-" : undefined;
      const completed = await serve({ range });
      expectResponse(completed, range ? 206 : 200, range ? contents.slice(4) : contents);
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
      const observations: boolean[] = [];
      interceptFile(
        service,
        1,
        (stream, authorization) => {
          const signal = service.authorizationSignal(authorization);
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
        },
        true,
      );

      const interrupted = await serve();
      expect(observations).toEqual([true, true]);
      expect(expiresAtMs).toBe(deadline);
      expect(interrupted).toMatchObject({
        res: { statusCode: 200, writableFinished: false, destroyed: true },
        body: contents.slice(0, closure === "expiry" ? 2 : 1),
      });
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
  async function prepare(onProgress?: (bytes: number) => void, maxServes: 1 | 3 = 1) {
    const artifact = await makeArtifact("bundle", "b".repeat(64));
    const artifactKey = "a".repeat(64);
    const state: { now: number; authorized: boolean; error?: Error } = {
      now: 1_000,
      authorized: true,
    };
    const owner = new AbortController();
    vi.spyOn(Date, "now").mockImplementation(() => state.now);
    const service = createArtifactTransferService();
    services.push(service);
    const progress = vi.fn<(bytes: number) => void>();
    const interrupted = vi.fn<(bytes: number, reason: string) => void>();
    const prepared = service.prepare({
      artifact,
      artifactKey,
      ttlMs: 1_000,
      maxServes,
      signal: owner.signal,
      isAuthorized: () => {
        if (state.error) {
          throw state.error;
        }
        return state.authorized;
      },
      onProgress: (bytes) => {
        progress(bytes);
        onProgress?.(bytes);
      },
      onInterrupted: interrupted,
    });
    let stream: ReadStream | undefined;
    interceptFile(
      service,
      2,
      (opened) => {
        stream = opened;
      },
      false,
      false,
    );
    const callback = createArtifactTransferHttpCallback(service);
    const h = {
      ...createResponse(),
      service,
      state,
      owner,
      prepared,
      artifactKey,
      tarballPath: artifact.tarballPath,
      progress,
      interrupted,
      authorize: () => service.authorize({ token: prepared.token, artifactKey }),
      admit: () => callback({ req: h.req, res: h.res, artifactKey, bearer: prepared.token }),
      failStream: (error: Error) => {
        if (!stream) {
          throw new Error("fixture stream has not started");
        }
        stream.destroy(error);
      },
      async run(range?: string) {
        if (h.res.destroyed || h.res.writableFinished) {
          Object.assign(h, createResponse());
        }
        if (range !== undefined) {
          h.req.headers.range = range;
        }
        const admission = await h.admit();
        if (admission.kind !== "authorized") {
          throw new Error("fixture artifact was not authorized");
        }
        await admission.handle();
      },
    };
    return h;
  }

  type Harness = Awaited<ReturnType<typeof prepare>>;
  it("reports no progress for revoked capabilities", async () => {
    const h = await prepare();
    h.service.revoke(h.prepared.token);
    await expect(h.admit()).resolves.toEqual({ kind: "unauthorized" });
    expect(h.progress).not.toHaveBeenCalled();
  });

  const closures: Record<string, (h: Harness) => unknown> = {
    expired: (h) => (h.state.now = h.prepared.expiresAtMs),
    "owner cancelled": (h) => h.owner.abort(new Error("private cancellation detail")),
    "authorization lost": (h) => (h.state.authorized = false),
    "throwing authorization": (h) => (h.state.error = new Error("private error")),
    released: (h) => h.service.revoke(h.prepared.token),
    shutdown: (h) => h.service.closeAll(),
  };
  it.each(Object.entries(closures))(
    "reports partial transfer closure for %s",
    async (closure, close) => {
      const h = await prepare(() => {
        close(h);
      }, 3);
      await h.run();
      expect(h.interrupted).toHaveBeenCalledExactlyOnceWith(
        2,
        `authority closed (${closure === "throwing authorization" ? "authorization lost" : closure})`,
      );
      expect(h.socketErrors).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "ABORT_ERR" }),
      );
      Object.assign(h.state, { authorized: true, error: undefined });
      expect(h.authorize()).toBeUndefined();
    },
  );

  it("records timer expiry independently of a later owner cancellation", async () => {
    const h = await prepare();
    const admission = h.authorize();
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
    expect(h.authorize()).toBeUndefined();
  });

  it.each([
    { range: undefined, status: 200, progress: [2, 4, 6] },
    { range: "bytes=2-", status: 206, progress: [4, 6] },
  ])(
    "reports completed progress without interruption for $status",
    async ({ range, status, progress }) => {
      const h = await prepare(() => {
        throw new Error("synthetic progress observer failure");
      });
      await h.run(range);
      h.socket.destroy();
      h.owner.abort();
      expect(h.res).toMatchObject({ statusCode: status, writableFinished: true });
      const { headers, body } = responseBytes(h.socket);
      expect(headers).toContain(`content-length: ${range ? "4" : "6"}`);
      expect(headers).toContain(`x-openclaw-content-sha256: ${"b".repeat(64)}`);
      expect(headers).toContain("accept-ranges: bytes");
      if (range) {
        expect(headers).toContain("content-range: bytes 2-5/6");
      } else {
        expect(headers.some((header) => header.startsWith("content-range:"))).toBe(false);
      }
      expect(body).toBe(range ? "ndle" : "bundle");
      expect(h.progress.mock.calls.flat()).toEqual(progress);
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
    expect(h.authorize()).toBeUndefined();
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
    for (const secret of [h.prepared.token, h.tarballPath, "private", "runtime.tgz", "\n"]) {
      expect(reason).not.toContain(secret);
    }
    expect(reason.length).toBeLessThanOrEqual(256);
  });
});
