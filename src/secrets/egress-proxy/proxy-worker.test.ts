import { once } from "node:events";
import fs from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { reserveTestPortListener, type TestPortClaim } from "../../test-utils/port-claims.js";
import { sealSecretSentinel } from "../sentinel.js";
import type { SecretEgressProcessGrant, SecretEgressProxyAuditEvent } from "./proxy-server.js";
import {
  startSecretEgressProxyWorker,
  type SecretEgressProxyWorkerHandle,
} from "./proxy-worker.js";

const secret = "synthetic-worker-egress-credential";
const sentinel = sealSecretSentinel(secret, { label: "WORKER_API_KEY" });
const bindings = [{ name: "WORKER_API_KEY", sentinel, allowedHosts: ["localhost"] }];
const proxies: SecretEgressProxyWorkerHandle[] = [];
const grants = new Set<SecretEgressProcessGrant>();
const sockets = new Set<Socket>();
const auditEvents: SecretEgressProxyAuditEvent[] = [];
const observed: Array<{ authorization: string | undefined; body: string }> = [];
const failure = vi.fn();
let seedDir: string;
let origin: Server;
let originPort: number;
let originClaim: TestPortClaim;
let closeOrigin: (() => Promise<void>) | undefined;
let proxy: SecretEgressProxyWorkerHandle;
let nativeWorker: Worker;
let streamingResponse: ServerResponse | undefined;
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(proxies.map((owned) => owned.stop()));
    expect(nativeWorker.threadId).toBe(-1);
    expect(failure).not.toHaveBeenCalled();
    await expect(proxy.registerProcess(bindings)).rejects.toThrow("stopped");
    origin?.closeAllConnections();
    await closeOrigin?.();
    await originClaim?.release();
    cleanup();
  }),
);

function trackSocket(socket: Socket): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
}

async function startWorker(onFailure = failure) {
  const caDir = dirs.make("openclaw-egress-worker-");
  for (const file of ["root-ca.pem", "root-ca-key.pem", "leaf-key.pem"]) {
    fs.copyFileSync(path.join(seedDir, file), path.join(caDir, file));
  }
  const created = createDeferredCore<Worker>();
  const onWorker = (worker: Worker) => created.resolve(worker);
  process.once("worker", onWorker);
  try {
    const handle = await startSecretEgressProxyWorker({
      caDir,
      allowedHosts: ["localhost"],
      onAudit: (event) => auditEvents.push(event),
      onFailure,
    });
    proxies.push(handle);
    return { handle, worker: await created.promise };
  } finally {
    process.off("worker", onWorker);
  }
}

async function register(owner = proxy, withBinding = true) {
  const grant = await owner.registerProcess(withBinding ? bindings : []);
  grants.add(grant);
  return grant;
}

function openRequest(
  grant: SecretEgressProcessGrant,
  options: {
    path?: string;
    host?: string;
    body?: string;
    owner?: SecretEgressProxyWorkerHandle;
  } = {},
): Promise<IncomingMessage> {
  const owner = options.owner ?? proxy;
  const proxyUrl = new URL(owner.proxyOrigin);
  const credentials = new URL(grant.env.HTTPS_PROXY!);
  const body = options.body ?? "";
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        agent: false,
        method: body ? "POST" : "GET",
        path: `https://${options.host ?? "localhost"}:${originPort}${options.path ?? "/"}`,
        headers: {
          "Proxy-Authorization": `Basic ${Buffer.from(`openclaw:${credentials.password}`).toString("base64")}`,
          Authorization: `Bearer ${sentinel}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      resolve,
    );
    request.once("socket", trackSocket);
    request.once("error", reject);
    request.end(body);
  });
}

async function readResponse(response: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.from(chunk));
  }
  return { status: response.statusCode, body: Buffer.concat(chunks).toString() };
}

beforeAll(async () => {
  seedDir = dirs.make("openclaw-egress-worker-seed-");
  const ca = await ensureSecretEgressProxyCa(seedDir);
  const leaf = await generateLocalProxyLeaf({ certDir: seedDir, ca, hostname: "localhost" });
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createHttpsServer(leaf, (request, response) => {
        const record = { authorization: request.headers.authorization, body: "" };
        observed.push(record);
        request.on("data", (chunk: Buffer) => {
          record.body += chunk.toString();
        });
        request.once("end", () => {
          if (request.url === "/sse") {
            streamingResponse = response;
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.write("data: first\n\n");
          } else {
            response.writeHead(200, { "Content-Length": 2 });
            response.end("ok");
          }
        });
      }),
  });
  origin = reservation.listener;
  origin.on("connection", trackSocket);
  originClaim = reservation.claim;
  originPort = reservation.claim.port;
  closeOrigin = reservation.releaseListener;
  const started = await startWorker();
  proxy = started.handle;
  nativeWorker = started.worker;
});

beforeEach(() => {
  auditEvents.length = 0;
  observed.length = 0;
  streamingResponse = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  streamingResponse?.destroy();
  for (const grant of grants) {
    grant.revoke();
  }
  grants.clear();
  // The health reply is ordered after grant cleanup on the same control port.
  await proxy.getCertificateStatus();
});

describe("secret egress Worker boundary", () => {
  it("acknowledges usable grants while keeping bindings, host policy, and audit data scoped", async () => {
    const grant = await register();
    expect(await readResponse(await openRequest(grant, { body: `${sentinel}:body` }))).toEqual({
      status: 200,
      body: "ok",
    });
    expect(observed).toEqual([{ authorization: `Bearer ${secret}`, body: `${secret}:body` }]);
    const unbound = await register(proxy, false);
    expect((await readResponse(await openRequest(unbound))).status).toBe(502);
    expect((await readResponse(await openRequest(grant, { host: "127.0.0.1" }))).status).toBe(403);
    expect(observed).toHaveLength(1);
    expect(await proxy.getCertificateStatus()).toMatchObject({
      state: "ready",
      failedCertificates: 0,
    });
    expect(auditEvents).toEqual([
      { kind: "forwarded", host: "localhost", substituted: true },
      { kind: "refused", host: "localhost", substituted: false, reason: "unresolved-sentinel" },
      { kind: "refused", host: "127.0.0.1", substituted: false, reason: "host-not-allowed" },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain(secret);
    expect(JSON.stringify(auditEvents)).not.toContain(sentinel);
  });

  it("revokes authority before its cleanup message arrives without revoking a sibling", async () => {
    const [revoked, sibling] = await Promise.all([register(), register()]);
    const response = await openRequest(revoked, { path: "/sse" });
    const first = createDeferredCore();
    const closed = new Promise<void>((resolve) => {
      response.once("close", resolve);
    });
    let received = "";
    response.on("error", () => {});
    response.on("data", (chunk: Buffer) => {
      received += chunk.toString();
      if (received.includes("data: first\n\n")) {
        first.resolve();
      }
    });
    await first.promise;
    const send = nativeWorker.postMessage.bind(nativeWorker);
    const held = vi.spyOn(nativeWorker, "postMessage").mockImplementation(() => {});
    revoked.revoke();
    const messages = held.mock.calls.slice();
    held.mockRestore();
    try {
      streamingResponse!.end("data: after revoke\n\n");
      await closed;
      expect(received).toBe("data: first\n\n");
      expect(response.complete).toBe(false);
      expect((await readResponse(await openRequest(revoked))).status).toBe(407);
      expect(await readResponse(await openRequest(sibling))).toEqual({ status: 200, body: "ok" });
      expect(observed).toEqual([
        { authorization: `Bearer ${secret}`, body: "" },
        { authorization: `Bearer ${secret}`, body: "" },
      ]);
    } finally {
      for (const args of messages) {
        send(...args);
      }
    }
  });

  it("delivers SSE data before the upstream completes its response", async () => {
    const response = await openRequest(await register(), { path: "/sse" });
    const first = createDeferredCore();
    const ended = once(response, "end");
    let received = "";
    response.on("data", (chunk: Buffer) => {
      received += chunk.toString();
      if (received.includes("data: first\n\n")) {
        first.resolve();
      }
    });
    await first.promise;
    expect(response.readableEnded).toBe(false);
    expect(streamingResponse?.writableEnded).toBe(false);
    streamingResponse!.end("data: final\n\n");
    await ended;
    expect(received).toBe("data: first\n\ndata: final\n\n");
  });

  it("fails closed on native Worker exit and settles pending control and network work", async () => {
    const failed = vi.fn();
    const isolated = await startWorker(failed);
    const response = await openRequest(await register(isolated.handle), {
      owner: isolated.handle,
      path: "/sse",
    });
    const closed = new Promise<void>((resolve) => {
      response.once("close", resolve);
    });
    response.on("error", () => {});
    response.resume();
    const holdStatus = vi.spyOn(isolated.worker, "postMessage").mockImplementationOnce(() => {});
    const pending = expect(isolated.handle.getCertificateStatus()).rejects.toThrow("unavailable");
    holdStatus.mockRestore();
    await isolated.worker.terminate();
    await Promise.all([pending, closed]);
    expect(failed).toHaveBeenCalledTimes(1);
    await expect(isolated.handle.registerProcess(bindings)).rejects.toThrow("unavailable");
    await isolated.handle.stop();
    expect(isolated.worker.threadId).toBe(-1);
  });
});
