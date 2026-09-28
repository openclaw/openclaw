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
import { ArtifactTransferBusyError } from "./artifact-transfer-service.js";
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
    artifact = {
      tarballPath: path.join(tempDirs.make("openclaw-artifact-response-"), "runtime.tgz"),
      tarballSha256: createHash("sha256").update(contents).digest("hex"),
      tarballBytes: Buffer.byteLength(contents),
    };
    await fs.writeFile(artifact.tarballPath, contents);
    ({ token, expiresAtMs } = service.prepare({
      artifact,
      isAuthorized: () => authorized,
      signal: owner.signal,
    }));
  });

  afterEach(() => {
    service.closeAll();
    rateLimiter?.dispose();
    rateLimiter = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function serve(writeError?: Error, artifactKey = artifact.tarballSha256) {
    const chunks: Buffer[] = [];
    class ResponseSocket extends Socket {
      override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
        chunks.push(Buffer.from(chunk));
        callback(writeError);
      }
      override _writev(writes: Array<{ chunk: Buffer }>, callback: (error?: Error) => void) {
        chunks.push(...writes.map(({ chunk }) => Buffer.from(chunk)));
        callback(writeError);
      }
    }
    const socket = new ResponseSocket();
    socket.on("error", () => {});
    const req = new IncomingMessage(socket);
    req.method = "GET";
    req.url = `/__openclaw__/worker-bootstrap/artifacts/${artifactKey}`;
    req.headers.authorization = `Bearer ${token}`;
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    try {
      await handleWorkerBootstrapArtifactTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback: createArtifactTransferHttpCallback(service),
        rateLimiter,
      });
      return { res, wire: Buffer.concat(chunks).toString("utf8") };
    } finally {
      socket.destroy();
    }
  }

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
    const interrupted = serve(new Error("synthetic connection reset"));
    try {
      await closing.promise;
      expect((await serve()).res.statusCode).toBe(503);
    } finally {
      release.resolve();
      await interrupted;
    }
    expect((await interrupted).res.writableFinished).toBe(false);
    for (let attempt = 2; attempt <= 3; attempt++) {
      const completed = await serve();
      expect(completed.res.statusCode).toBe(200);
      expect(completed.res.writableFinished).toBe(true);
      expect(completed.wire.endsWith(contents)).toBe(true);
    }
    expect((await serve()).res.statusCode).toBe(404);
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

  it.each(["owner", "expiry", "signal"] as const)(
    "keeps busy artifact identity opaque and rejects %s closure",
    async (closure) => {
      service.authorize({ token, artifactKey: artifact.tarballSha256 });
      expect((await serve(undefined, "0".repeat(64))).res.statusCode).toBe(404);
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
