import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import * as https from "node:https";
import { createServer as createHttpsServer, type Server } from "node:https";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as proxyCa from "../../proxy-capture/ca.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { mintSecretSentinel } from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

vi.mock("node:https", { spy: true });

const run = { instanceId: "instance-1", runId: "run-1" };
const sibling = { instanceId: "instance-2", runId: "run-2" };
const value = "synthetic-lifecycle-credential";
const seedDirs = createTempDirTracker();
let seedDir: string;
let originLeaf: Awaited<ReturnType<typeof proxyCa.generateLocalProxyLeaf>>;
let caDir: string;
let proxy: SecretEgressProxyHandle;
let origin: Server;
let originPort: number;
let sentinel: string;
let proxyEnv: Record<string, string>;
let observed: Array<{ authorization: string | undefined; body: string }>;
let auditEvents: Array<{ kind: string; reason?: string }>;
let incoming: Map<string, IncomingMessage>;
let responses: Map<string, ServerResponse>;
let bodyReceived: Set<string>;
const sockets = new Set<Socket>();

function trackSocket<T extends Socket>(socket: T): T {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

function connectTunnel(env = proxyEnv): Promise<{ status: number; socket?: Socket }> {
  const url = new URL(env.HTTPS_PROXY!);
  return new Promise((resolve) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      method: "CONNECT",
      // CONNECT targets this test proxy, never Node's environment proxy.
      agent: false,
      path: `localhost:${originPort}`,
      headers: {
        "Proxy-Authorization": `Basic ${Buffer.from(`openclaw:${url.password}`).toString("base64")}`,
      },
    });
    request.once("socket", trackSocket);
    request.once("connect", (response, socket) => {
      resolve({ status: response.statusCode ?? 0, socket: trackSocket(socket) });
    });
    request.once("error", () => resolve({ status: 0 }));
    request.end();
  });
}

async function openTlsTunnel(env = proxyEnv): Promise<tls.TLSSocket> {
  const connected = await connectTunnel(env);
  expect(connected.status).toBe(200);
  const socket = trackSocket(
    tls.connect({
      socket: connected.socket,
      servername: "localhost",
      ca: fs.readFileSync(proxy.caCertPath),
    }),
  );
  await once(socket, "secureConnect");
  socket.resume();
  return socket;
}

function onClose(socket: Socket | IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
  });
}

async function sendCredential(socket: tls.TLSSocket, body?: string): Promise<void> {
  const closed = onClose(socket);
  socket.write(
    `${body === undefined ? "GET" : "POST"} / HTTP/1.1\r\nHost: localhost:${originPort}\r\nConnection: close\r\nAuthorization: Bearer ${sentinel}\r\n${body === undefined ? "" : `Content-Length: ${Buffer.byteLength(body)}\r\n`}\r\n${body ?? ""}`,
  );
  await closed;
}

function register(targetRun = run): Record<string, string> {
  return proxy.registerRun(targetRun, [
    { name: "SERVICE_API_KEY", sentinel, allowedHosts: ["localhost"] },
  ]);
}

beforeAll(async () => {
  seedDir = seedDirs.make("openclaw-egress-lifecycle-seed-");
  const ca = await proxyCa.ensureSecretEgressProxyCa(seedDir);
  originLeaf = await proxyCa.generateLocalProxyLeaf({
    certDir: seedDir,
    ca,
    hostname: "localhost",
  });
});

afterAll(() => seedDirs.cleanup());

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_SECRET_SENTINELS", undefined);
  observed = [];
  auditEvents = [];
  incoming = new Map();
  responses = new Map();
  bodyReceived = new Set();
  const { createServer } = await vi.importActual<typeof https>("node:https");
  vi.spyOn(https, "createServer").mockImplementation((options, listener) =>
    createServer(options, listener).on("request", (request, response) => {
      const proof = request.headers["x-upload-proof"];
      if (typeof proof === "string" && !incoming.has(proof)) {
        incoming.set(proof, request);
        responses.set(proof, response);
        request.once("data", () => bodyReceived.add(proof));
      }
    }),
  );
  caDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-egress-lifecycle-"));
  // Reuse initial material only; request-time issuance and TLS state stay per case.
  for (const file of ["root-ca.pem", "root-ca-key.pem", "leaf-key.pem"]) {
    fs.copyFileSync(path.join(seedDir, file), path.join(caDir, file));
  }
  proxy = await startSecretEgressProxyServer({
    caDir,
    onAudit: (event) => auditEvents.push(event),
  });
  const leaf = { cert: Buffer.from(originLeaf.cert), key: Buffer.from(originLeaf.key) };
  origin = createHttpsServer(leaf, (request, response) => {
    const record = { authorization: request.headers.authorization, body: "" };
    observed.push(record);
    request.on("error", () => {});
    request.on("data", (chunk: Buffer) => {
      record.body += chunk.toString();
    });
    request.once("end", () => {
      response.writeHead(200, { Connection: "close", "Content-Length": 2 });
      response.end("ok");
    });
  });
  origin.on("connection", trackSocket);
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const address = origin.address();
  if (!address || typeof address === "string") {
    throw new Error("Origin did not bind");
  }
  originPort = address.port;
  sentinel = mintSecretSentinel(value, { label: "egress-lifecycle" });
  proxyEnv = register();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await proxy?.stop();
  if (origin) {
    await new Promise<void>((resolve) => {
      origin.close(() => resolve());
    });
  }
  fs.rmSync(caDir, { recursive: true, force: true });
});

describe("secret egress registration lifecycle", () => {
  it.each(["header", "body", "url"] as const)(
    "hardening: rechecks %s credentials after same-run binding replacement",
    async (location) => {
      const socket = await openTlsTunnel();
      const received: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      const closed = onClose(socket);
      const prefix = location === "body" ? sentinel + "x".repeat(32) : "prefix";
      const url = location === "url" ? "/?token=" + sentinel : "/";
      const auth = location === "header" ? "Authorization: Bearer " + sentinel + "\r\n" : "";
      socket.write(
        "POST " +
          url +
          " HTTP/1.1\r\nHost: localhost:" +
          originPort +
          "\r\nConnection: close\r\nX-Upload-Proof: replacement\r\n" +
          auth +
          "Content-Length: " +
          (Buffer.byteLength(prefix) + 1) +
          "\r\n\r\n" +
          prefix,
      );
      await vi.waitFor(() => expect(bodyReceived.has("replacement")).toBe(true));
      proxy.registerRun(run, []);
      socket.write("!");
      await closed;
      expect(observed).toEqual([]);
      expect(Buffer.concat(received).toString()).toContain("502");
      expect(auditEvents.some((event) => event.kind === "forwarded")).toBe(false);
    },
  );

  it("hardening: does not open upstream transport while collecting", async () => {
    const socket = await openTlsTunnel();
    const request = vi.spyOn(https, "request").mockClear();
    socket.write(
      "POST / HTTP/1.1\r\nHost: localhost:" +
        originPort +
        "\r\nX-Upload-Proof: preparing\r\nContent-Length: 10\r\n\r\nabc",
    );
    await vi.waitFor(() => expect(bodyReceived.has("preparing")).toBe(true));
    expect(request).not.toHaveBeenCalled();
    expect(auditEvents).toEqual([]);
  });

  it("hardening: bounds aggregate reservations without blocking mixed small uploads", async () => {
    const held = await openTlsTunnel();
    held.write(
      "POST / HTTP/1.1\r\nHost: localhost:" +
        originPort +
        "\r\nX-Upload-Proof: large\r\nContent-Length: 104857600\r\n\r\nx",
    );
    await vi.waitFor(() => expect(bodyReceived.has("large")).toBe(true));
    const rejected = await openTlsTunnel(register(sibling));
    const received: Buffer[] = [];
    rejected.on("data", (chunk: Buffer) => received.push(chunk));
    rejected.write(
      "POST / HTTP/1.1\r\nHost: localhost:" + originPort + "\r\nContent-Length: 41943040\r\n\r\nx",
    );
    await vi.waitFor(() => expect(Buffer.concat(received).toString()).toContain("503"));
    const small = await Promise.all(Array.from({ length: 8 }, () => openTlsTunnel()));
    await Promise.all(small.map((socket) => sendCredential(socket, "ok")));
    expect(observed).toHaveLength(8);
    const closed = onClose(held);
    held.destroy();
    await closed;
  });

  it("hardening: expires an incomplete CONNECT upload even without a listening TLS server", async () => {
    const socket = await openTlsTunnel();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closed = onClose(socket);
    socket.write(
      "POST / HTTP/1.1\r\nHost: localhost:" +
        originPort +
        "\r\nX-Upload-Proof: deadline\r\nContent-Length: 104857600\r\n\r\nx",
    );
    await vi.waitFor(() => expect(bodyReceived.has("deadline")).toBe(true));
    await vi.advanceTimersByTimeAsync(300_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    await closed;
    expect(observed).toEqual([]);
    expect(auditEvents.some((event) => event.kind === "forwarded")).toBe(false);
    await sendCredential(await openTlsTunnel());
    expect(observed).toHaveLength(1);
  });

  it.each([false, true])(
    "hardening: rechecks only relevant current traffic policy (restricted: %s)",
    async (restricted) => {
      if (restricted) {
        await proxy.stop();
        proxy = await startSecretEgressProxyServer({
          caDir,
          allowedHosts: [],
          onAudit: (event) => auditEvents.push(event),
        });
        proxyEnv = register();
      }
      const socket = await openTlsTunnel();
      const closed = onClose(socket);
      const received: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.write(
        "POST / HTTP/1.1\r\nHost: localhost:" +
          originPort +
          "\r\nConnection: close\r\nX-Upload-Proof: policy\r\nContent-Length: 2\r\n\r\na",
      );
      await vi.waitFor(() => expect(bodyReceived.has("policy")).toBe(true));
      proxy.registerRun(run, []);
      socket.write("b");
      await closed;
      expect(Buffer.concat(received).toString()).toContain(restricted ? "403" : "200");
      expect(observed).toHaveLength(restricted ? 0 : 1);
    },
  );

  it("hardening: bounds tiny-request count and releases all aborted reservations", async () => {
    const held = await Promise.all(Array.from({ length: 65 }, () => openTlsTunnel()));
    for (const [index, socket] of held.entries()) {
      socket.write(
        "POST / HTTP/1.1\r\nHost: localhost:" +
          originPort +
          "\r\nX-Upload-Proof: count-" +
          index +
          "\r\nContent-Length: 2\r\n\r\nx",
      );
    }
    await vi.waitFor(() => expect(bodyReceived.size).toBe(65));
    expect([...responses.values()].filter((response) => response.statusCode === 503)).toHaveLength(
      1,
    );
    expect([...responses.values()].filter((response) => !response.headersSent)).toHaveLength(64);
    const closed = held.filter((socket) => !socket.destroyed).map((socket) => onClose(socket));
    for (const socket of held) {
      socket.destroy();
    }
    await Promise.all(closed);
    await vi.waitFor(() =>
      expect([...incoming.values()].every((request) => request.destroyed)).toBe(true),
    );
    const next = await openTlsTunnel();
    next.write(
      "POST / HTTP/1.1\r\nHost: localhost:" +
        originPort +
        "\r\nX-Upload-Proof: count-reused\r\nContent-Length: 104857600\r\n\r\nx",
    );
    await vi.waitFor(() => expect(bodyReceived.has("count-reused")).toBe(true));
    expect(responses.get("count-reused")?.headersSent).toBe(false);
  });

  it("hardening: waits for actual upstream send and expires a stalled TLS handshake", async () => {
    const peers = new Set<Socket>();
    const stalled = net.createServer((socket) => {
      trackSocket(socket);
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
    });
    stalled.listen(0, "127.0.0.1");
    await once(stalled, "listening");
    const address = stalled.address();
    if (!address || typeof address === "string") {
      throw new Error("No stalled origin port");
    }
    const previousPort = originPort;
    originPort = address.port;
    try {
      const socket = await openTlsTunnel();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const connected = once(stalled, "connection");
      const received: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.write(
        "POST / HTTP/1.1\r\nHost: localhost:" +
          originPort +
          "\r\nConnection: close\r\nContent-Length: 5\r\n\r\nhello",
      );
      const [peer] = await connected;
      expect(auditEvents).toEqual([]);
      await vi.advanceTimersByTimeAsync(300_000);
      vi.useRealTimers();
      await vi.waitFor(() => expect(socket.destroyed).toBe(true));
      expect(Buffer.concat(received).toString()).toContain("504");
      expect(auditEvents).toEqual([
        { kind: "refused", host: "localhost", substituted: false, reason: "request-timeout" },
      ]);
      peer.destroy();
    } finally {
      vi.useRealTimers();
      originPort = previousPort;
      for (const peer of peers) {
        peer.destroy();
      }
      await new Promise<void>((resolve) => {
        stalled.close(() => resolve());
      });
    }
    await sendCredential(await openTlsTunnel());
    expect(observed).toHaveLength(1);
  });

  it("hardening: forwards the exact 100 MiB cap under backpressure with byte identity", async () => {
    origin.removeAllListeners("request");
    const expectedHash = createHash("sha256");
    const arrived = createDeferredCore<{
      bytes: number;
      hash: string;
      contentLength?: string;
      encoding?: string;
    }>();
    origin.on("request", (request, response) => {
      const hash = createHash("sha256");
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      request.once("end", () => {
        arrived.resolve({
          bytes,
          hash: hash.digest("hex"),
          contentLength: request.headers["content-length"],
          encoding: request.headers["transfer-encoding"],
        });
        response.writeHead(200, { Connection: "close", "Content-Length": 2 });
        response.end("ok");
      });
    });
    const socket = await openTlsTunnel();
    const closed = onClose(socket);
    socket.write(
      "POST / HTTP/1.1\r\nHost: localhost:" +
        originPort +
        "\r\nConnection: close\r\nContent-Length: 104857600\r\n\r\n",
    );
    const chunk = Buffer.alloc(64 * 1024, 165);
    for (let i = 0; i < 1600; i++) {
      expectedHash.update(chunk);
      if (!socket.write(chunk)) {
        await once(socket, "drain");
      }
    }
    await closed;
    expect(await arrived.promise).toEqual({
      bytes: 104857600,
      hash: expectedHash.digest("hex"),
      contentLength: "104857600",
      encoding: undefined,
    });
    // Completing send releases the full-size reservation, not just collection slots.
    const next = await openTlsTunnel();
    next.write(
      "POST / HTTP/1.1\r\nHost: localhost:" +
        originPort +
        "\r\nX-Upload-Proof: cap-reused\r\nContent-Length: 104857600\r\n\r\nx",
    );
    await vi.waitFor(() => expect(bodyReceived.has("cap-reused")).toBe(true));
    expect(responses.get("cap-reused")?.headersSent).toBe(false);
  });

  it("keeps the process CA trusted beyond the first day", () => {
    const cert = new X509Certificate(fs.readFileSync(proxy.caCertPath));
    const afterOneDay = Math.floor(cert.validFromDate.getTime() / 1000) + 25 * 60 * 60;
    expect(() =>
      execFileSync(
        "openssl",
        ["verify", "-CAfile", proxy.caCertPath, "-attime", String(afterOneDay), proxy.caCertPath],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("renews cached leaves without replacing client trust or established connections", async () => {
    const issued: X509Certificate[] = [];
    const issueLeaf = proxyCa.generateLocalProxyLeaf;
    vi.spyOn(proxyCa, "generateLocalProxyLeaf").mockImplementation(async (params) => {
      const leaf = await issueLeaf(params);
      issued.push(new X509Certificate(leaf.cert));
      return leaf;
    });
    const existing = await openTlsTunnel();
    const previous = issued[0]!;
    const trustedCa = fs.readFileSync(proxy.caCertPath);
    // OpenSSL uses the native clock. Advance the cache's clock into the leaf's
    // renewal window while real TLS verifies both certificates and the same CA.
    vi.spyOn(Date, "now").mockReturnValue(previous.validToDate.getTime() - 30 * 60_000);
    const renewed = await Promise.all([openTlsTunnel(), openTlsTunnel()]);
    for (const socket of renewed) {
      await sendCredential(socket);
    }
    expect(fs.readFileSync(proxy.caCertPath)).toEqual(trustedCa);
    await sendCredential(existing);
    expect(observed).toHaveLength(3);
    expect(issued.length).toBe(2);
    expect(issued[1]!.fingerprint256).not.toBe(previous.fingerprint256);
    expect(issued[1]!.checkIssued(new X509Certificate(trustedCa))).toBe(true);
  });
  it.each([false, true])(
    "recovers certificate failures on the next request (renewal: %s)",
    async (renewing) => {
      const existing = renewing ? await openTlsTunnel() : undefined;
      if (renewing) {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 23.5 * 60 * 60_000);
      }
      vi.spyOn(proxyCa, "generateLocalProxyLeaf").mockRejectedValueOnce(
        new Error("synthetic-private-openssl-output"),
      );
      expect((await connectTunnel()).status).toBe(502);
      const failed = proxy.getCertificateStatus();
      expect(failed.state).toBe("degraded");
      expect(failed.failedCertificates).toBe(1);
      expect(failed.message).toContain("retry the request");
      expect(JSON.stringify(failed)).not.toContain("synthetic-private-openssl-output");
      if (existing) {
        await sendCredential(existing);
      }
      await sendCredential(await openTlsTunnel());
      expect(proxy.getCertificateStatus().state).toBe("ready");
      expect(proxy.getCertificateStatus().failedCertificates).toBe(0);
      expect(observed.length).toBe(renewing ? 2 : 1);
    },
  );

  it("reports root expiry without minting leaves or replacing the trust bundle", async () => {
    const trust = fs.readFileSync(proxyEnv.NODE_EXTRA_CA_CERTS!);
    const validity = new X509Certificate(fs.readFileSync(proxy.caCertPath));
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(validity.validToDate.getTime() - 60_000);
    expect(proxy.getCertificateStatus().message).toContain("expires within seven days");
    clock.mockReturnValue(validity.validToDate.getTime());
    const generateLeaf = vi.spyOn(proxyCa, "generateLocalProxyLeaf");
    expect((await connectTunnel()).status).toBe(502);
    expect(proxy.getCertificateStatus().message).toContain("restart the Gateway");
    expect(generateLeaf).not.toHaveBeenCalled();
    expect(fs.readFileSync(proxyEnv.NODE_EXTRA_CA_CERTS!)).toEqual(trust);
    clock.mockRestore();
    await sendCredential(await openTlsTunnel());
    expect(proxy.getCertificateStatus().state).toBe("ready");
  });

  it.each(["revoke", "replace", "stop"] as const)(
    "%s closes established TLS before its first credential request",
    async (action) => {
      const oldConnection = await openTlsTunnel();
      const siblingEnv = register(sibling);
      const siblingConnection = await openTlsTunnel(siblingEnv);
      let stopped: Promise<void> | undefined;
      if (action === "stop") {
        stopped = proxy.stop();
      } else {
        proxy.revokeRun(run);
      }
      if (action === "replace") {
        proxyEnv = register();
      }
      await sendCredential(oldConnection);
      expect(observed).toEqual([]);
      if (stopped) {
        await stopped;
        expect(() => register()).toThrow();
        return;
      }
      await sendCredential(siblingConnection);
      expect(observed).toEqual([{ authorization: `Bearer ${value}`, body: "" }]);
      if (action === "replace") {
        await sendCredential(await openTlsTunnel());
        expect(observed).toHaveLength(2);
      }
    },
  );

  it("does not reuse a revoked registration's cached TLS bindings on a fresh connection", async () => {
    await sendCredential(await openTlsTunnel());
    proxy.revokeRun(run);
    proxyEnv = proxy.registerRun(run, []);
    await sendCredential(await openTlsTunnel());
    expect(observed).toEqual([{ authorization: `Bearer ${value}`, body: "" }]);
  });

  it.each([undefined, 100 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER])(
    "streams declared length %s without buffering the upload and revokes between chunks",
    async (contentLength) => {
      const socket = await openTlsTunnel();
      const firstChunk = createDeferredCore<IncomingMessage>();
      origin.once("request", (request) => request.once("data", () => firstChunk.resolve(request)));
      const framing =
        contentLength === undefined
          ? "Transfer-Encoding: chunked"
          : `Content-Length: ${contentLength}`;
      socket.write(
        `POST / HTTP/1.1\r\nHost: localhost:${originPort}\r\nConnection: close\r\n${framing}\r\n\r\n`,
      );
      const prefix = "safe-prefix".repeat(100);
      const split = Math.floor(sentinel.length / 2);
      const first = prefix + sentinel.slice(0, split);
      socket.write(
        contentLength === undefined
          ? `${Buffer.byteLength(first).toString(16)}\r\n${first}\r\n`
          : first,
      );
      // Arrival before sending the rest proves that even enormous declared lengths
      // do not allocate or wait for a complete fixed-length buffer.
      const upstreamRequest = await firstChunk.promise;
      expect(upstreamRequest.headers["content-length"]).toBeUndefined();
      expect(upstreamRequest.headers["transfer-encoding"]).toBe("chunked");
      const upstreamClosed = onClose(upstreamRequest);
      const clientClosed = onClose(socket);
      proxy.revokeRun(run);
      const last = sentinel.slice(split);
      socket.write(
        contentLength === undefined
          ? `${Buffer.byteLength(last).toString(16)}\r\n${last}\r\n0\r\n\r\n`
          : last,
      );
      await Promise.all([upstreamClosed, clientClosed]);
      expect(observed).toEqual([{ authorization: undefined, body: prefix }]);
      await sendCredential(await openTlsTunnel(register(sibling)));
      expect(observed.at(-1)?.authorization).toBe(`Bearer ${value}`);
    },
  );

  it.each(["revoke", "replace", "stop", "disconnect", "short body"] as const)(
    "%s discards an incomplete fixed-length upload and releases its reservation",
    async (action) => {
      const socket = await openTlsTunnel();
      const clientClosed = onClose(socket);
      const prefix = "safe-prefix".repeat(100) + sentinel.slice(0, Math.floor(sentinel.length / 2));
      socket.write(
        `POST / HTTP/1.1\r\nHost: localhost:${originPort}\r\nConnection: close\r\nX-Upload-Proof: cleanup\r\nContent-Length: 104857600\r\n\r\n${prefix}`,
      );
      await vi.waitFor(() => expect(bodyReceived.has("cleanup")).toBe(true));
      expect(responses.get("cleanup")?.headersSent).toBe(false);
      let stopped: Promise<void> | undefined;
      if (action === "disconnect") {
        socket.destroy();
      } else if (action === "short body") {
        socket.end();
      } else if (action === "stop") {
        stopped = proxy.stop();
      } else {
        proxy.revokeRun(run);
        if (action === "replace") {
          proxyEnv = register();
        }
      }
      await Promise.all([clientClosed, stopped]);
      expect(observed).toEqual([]);
      if (action !== "stop") {
        const next = await openTlsTunnel(register(sibling));
        next.write(
          "POST / HTTP/1.1\r\nHost: localhost:" +
            originPort +
            "\r\nX-Upload-Proof: reused\r\nContent-Length: 104857600\r\n\r\nx",
        );
        await vi.waitFor(() => expect(bodyReceived.has("reused")).toBe(true));
        expect(responses.get("reused")?.headersSent).toBe(false);
        next.destroy();
        await sendCredential(await openTlsTunnel(register(sibling)));
        expect(observed).toHaveLength(1);
      }
    },
  );

  it.each([
    { action: "revoke", renewing: false },
    { action: "stop", renewing: false },
    { action: "replace", renewing: false },
    { action: "revoke", renewing: true },
    { action: "stop", renewing: true },
    { action: "replace", renewing: true },
  ] as const)(
    "$action fences CONNECT while certificate work is pending (renewal: $renewing)",
    async ({ action, renewing }) => {
      if (renewing) {
        await sendCredential(await openTlsTunnel());
        observed = [];
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 23.5 * 60 * 60_000);
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const settled = createDeferredCore();
      let leafPrepared = false;
      const generateLeaf = proxyCa.generateLocalProxyLeaf;
      vi.spyOn(proxyCa, "generateLocalProxyLeaf").mockImplementationOnce(async (params) => {
        entered.resolve();
        try {
          await release.promise;
          const leaf = await generateLeaf(params);
          leafPrepared = true;
          return leaf;
        } finally {
          settled.resolve();
        }
      });
      const connecting = connectTunnel();
      try {
        await entered.promise;
        const stopping = action === "stop" ? proxy.stop() : undefined;
        if (action !== "stop") {
          proxy.revokeRun(run);
          if (action === "replace") {
            proxyEnv = register();
          }
        }
        release.resolve();
        expect((await connecting).status).not.toBe(200);
        await stopping;
        if (stopping) {
          expect(leafPrepared).toBe(true);
        }
        expect(observed).toEqual([]);
        if (action !== "stop") {
          await sendCredential(await openTlsTunnel(register()));
          expect(observed.at(-1)?.authorization).toBe(`Bearer ${value}`);
        }
      } finally {
        release.resolve();
        await connecting;
        await settled.promise;
      }
    },
  );

  it("releases both ends of a bypass CONNECT on revocation", async () => {
    await proxy.stop();
    proxy = await startSecretEgressProxyServer({
      caDir,
      bypassHosts: ["localhost"],
      onAudit: () => {},
    });
    proxyEnv = register();
    const connected = once(origin, "secureConnection");
    const socket = await openTlsTunnel();
    const [upstreamSocket] = await connected;
    const upstreamClosed = onClose(upstreamSocket);
    proxy.revokeRun(run);
    await sendCredential(socket);
    await upstreamClosed;
    expect(observed).toEqual([]);
    await sendCredential(await openTlsTunnel(register(sibling)));
    expect(observed.at(-1)?.authorization).toBe(`Bearer ${sentinel}`);
  });
});
