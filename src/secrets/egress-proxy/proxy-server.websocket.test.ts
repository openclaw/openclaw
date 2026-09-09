import { once } from "node:events";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { sealSecretSentinel } from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

type AuditEvent = Parameters<Parameters<typeof startSecretEgressProxyServer>[0]["onAudit"]>[0];

const run = { instanceId: "websocket-instance", runId: "websocket-run" };
const value = "synthetic-websocket-credential";
const seedDirs = createTempDirTracker();
const sockets = new Set<Socket>();
const clients = new Set<WebSocket>();
let seedDir: string;
let leaf: Awaited<ReturnType<typeof generateLocalProxyLeaf>>;
let caDir: string;
let proxy: SecretEgressProxyHandle;
let origin: Server;
let wss: WebSocketServer;
let port: number;
let sentinel: string;
let proxyEnv: Record<string, string>;
let auditEvents: AuditEvent[];
let observed: Array<{
  authorization: string | undefined;
  url: string;
  proxyAuth: string | undefined;
}>;

function track<T extends Socket>(socket: T): T {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

function connectTunnel(auth = new URL(proxyEnv.HTTPS_PROXY!).password) {
  const proxyUrl = new URL(proxy.proxyOrigin);
  return new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    const request = httpRequest({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port,
      method: "CONNECT",
      path: `localhost:${port}`,
      headers: auth
        ? { "Proxy-Authorization": `Basic ${Buffer.from(`openclaw:${auth}`).toString("base64")}` }
        : {},
    });
    request.once("socket", track);
    request.once("connect", (response, socket) =>
      resolve({ status: response.statusCode ?? 0, socket: track(socket) }),
    );
    request.once("error", reject);
    request.end();
  });
}

async function connectTls(): Promise<tls.TLSSocket> {
  const connected = await connectTunnel();
  expect(connected.status).toBe(200);
  const socket = track(
    tls.connect({
      socket: connected.socket,
      servername: "localhost",
      ca: fs.readFileSync(proxy.caCertPath),
    }),
  );
  await once(socket, "secureConnect");
  expect(socket.authorized).toBe(true);
  return socket;
}

async function websocket(
  params: { direct?: boolean; credential?: string; pathname?: string } = {},
) {
  const socket = params.direct ? undefined : await connectTls();
  const client = new WebSocket(`wss://localhost:${port}${params.pathname ?? "/"}`, {
    ...(socket ? { createConnection: () => socket } : {}),
    ca: fs.readFileSync(proxy.caCertPath),
    headers: { Authorization: `Bearer ${params.credential ?? sentinel}` },
    handshakeTimeout: 2_000,
  });
  clients.add(client);
  client.on("error", () => {});
  return client;
}

async function rawUpgrade(
  params: {
    credential?: string;
    pathname?: string;
    head?: Buffer;
    upgrade?: string;
    forward?: boolean;
    auth?: string;
  } = {},
) {
  const socket = params.forward
    ? await new Promise<Socket>((resolve, reject) => {
        const endpoint = new URL(proxy.proxyOrigin);
        const connected = track(net.connect(Number(endpoint.port), endpoint.hostname));
        connected.once("connect", () => resolve(connected));
        connected.once("error", reject);
      })
    : await connectTls();
  const received: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => received.push(chunk));
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  const auth = params.auth ?? new URL(proxyEnv.HTTPS_PROXY!).password;
  const proxyAuth =
    params.forward && auth
      ? `Proxy-Authorization: Basic ${Buffer.from(`openclaw:${auth}`).toString("base64")}\r\n`
      : "";
  const target = params.forward
    ? `https://localhost:${port}${params.pathname ?? "/"}`
    : (params.pathname ?? "/");
  socket.write(
    Buffer.concat([
      Buffer.from(
        `GET ${target} HTTP/1.1\r\nHost: localhost:${port}\r\n${proxyAuth}Connection: Upgrade\r\nUpgrade: ${params.upgrade ?? "websocket"}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${params.credential ?? sentinel}\r\n\r\n`,
      ),
      params.head ?? Buffer.alloc(0),
    ]),
  );
  return { socket, received, closed };
}

async function receive(request: Awaited<ReturnType<typeof rawUpgrade>>, text: string) {
  while (!Buffer.concat(request.received).includes(Buffer.from(text))) {
    await once(request.socket, "data");
  }
  return Buffer.concat(request.received).toString();
}

beforeAll(async () => {
  seedDir = seedDirs.make("openclaw-egress-websocket-seed-");
  const ca = await ensureSecretEgressProxyCa(seedDir);
  leaf = await generateLocalProxyLeaf({ certDir: seedDir, ca, hostname: "localhost" });
});
afterAll(() => seedDirs.cleanup());

beforeEach(async () => {
  caDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-egress-websocket-"));
  for (const file of ["root-ca.pem", "root-ca-key.pem", "leaf-key.pem"]) {
    fs.copyFileSync(path.join(seedDir, file), path.join(caDir, file));
  }
  auditEvents = [];
  proxy = await startSecretEgressProxyServer({
    caDir,
    onAudit: (event) => auditEvents.push(event),
  });
  observed = [];
  origin = createHttpsServer(leaf, (_request, response) => response.end("ordinary-https"));
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  wss.on("connection", (socket) => {
    socket.on("error", () => {});
    socket.send("ready");
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  origin.on("connection", track);
  origin.on("upgrade", (request, socket, head) => {
    observed.push({
      authorization: request.headers.authorization,
      url: request.url ?? "",
      proxyAuth: request.headers["proxy-authorization"],
    });
    if (request.url === "/reject") {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 6\r\n\r\ndenied",
      );
      return;
    }
    if (request.url === "/reset") {
      socket.destroy();
      return;
    }
    if (request.url === "/invalid-upgrade") {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: other\r\n\r\n",
      );
      return;
    }
    if (request.url === "/pending") {
      return;
    }
    socket.cork();
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
    socket.uncork();
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const address = origin.address();
  if (!address || typeof address === "string") {
    throw new Error("Origin did not bind");
  }
  port = address.port;
  sentinel = sealSecretSentinel(value, { label: "websocket-test" });
  proxyEnv = proxy.registerRun(run, [
    { name: "SERVICE_KEY", sentinel, allowedHosts: ["localhost"] },
  ]);
});

afterEach(async () => {
  for (const client of clients) {
    client.terminate();
  }
  clients.clear();
  for (const client of wss.clients) {
    client.terminate();
  }
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await proxy.stop();
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    origin.close(() => resolve());
  });
  fs.rmSync(caDir, { recursive: true, force: true });
});

describe("secret egress WebSocket forwarding", () => {
  it("closes a pipelined upgrade while a previous HTTP response owns the socket", async () => {
    const endpoint = new URL(proxy.proxyOrigin);
    const socket = track(net.connect(Number(endpoint.port), endpoint.hostname));
    socket.resume();
    await once(socket, "connect");
    const closed = once(socket, "close");
    // No proxy credentials: neither request may reach the origin. Both arrive
    // before the first response finishes, while Node still owns its socket.
    socket.write(
      `GET https://localhost:${port}/ HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n` +
        `GET https://localhost:${port}/socket HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );
    await closed;
    expect(observed).toEqual([]);
  });

  it("substitutes handshake credentials and preserves bidirectional framed data", async () => {
    const direct = await websocket({ direct: true, credential: value });
    expect((await once(direct, "message"))[0].toString()).toBe("ready");
    direct.close();

    const client = await websocket({ pathname: `/socket?key=${sentinel}` });
    expect((await once(client, "message"))[0].toString()).toBe("ready");
    expect(observed).toEqual([
      { authorization: `Bearer ${value}`, url: "/", proxyAuth: undefined },
      { authorization: `Bearer ${value}`, url: `/socket?key=${value}`, proxyAuth: undefined },
    ]);
    // Frames are opaque, not HTTP bodies: masked/fragmented payloads must not be rewritten.
    const payload = `opaque:${sentinel}`;
    const echoed = once(client, "message");
    client.send(payload.slice(0, 10), { fin: false });
    client.send(payload.slice(10), { fin: true });
    expect((await echoed)[0].toString()).toBe(payload);
    const binary = once(client, "message");
    client.send(Buffer.from([0, 255, 128, 1]));
    expect((await binary)[0]).toEqual(Buffer.from([0, 255, 128, 1]));
    const clientClosed = once(client, "close");
    client.close(1000, "done");
    expect((await clientClosed)[0]).toBe(1000);
    expect(auditEvents).toEqual([{ kind: "forwarded", host: "localhost", substituted: true }]);
  });

  it.each(["missing", "wrong", "revoked"])(
    "refuses %s proxy credentials before WSS origin access",
    async (kind) => {
      if (kind === "revoked") {
        proxy.revokeRun(run);
      }
      const auth = kind === "missing" ? "" : kind === "wrong" ? "A".repeat(43) : undefined;
      expect((await connectTunnel(auth)).status).toBe(407);
      const forwarded = await rawUpgrade({ forward: true, auth });
      await forwarded.closed;
      expect(Buffer.concat(forwarded.received).toString()).toMatch(/^HTTP\/1\.1 407 /);
      expect(observed).toEqual([]);
    },
  );

  it("authenticates and substitutes an absolute-HTTPS forwarded upgrade", async () => {
    const request = await rawUpgrade({ forward: true });
    expect(await receive(request, "ready")).toMatch(/^HTTP\/1\.1 101 /);
    expect(observed).toEqual([
      { authorization: `Bearer ${value}`, url: "/", proxyAuth: undefined },
    ]);
  });

  it.each(["unknown", "wrong-host", "unbound"])(
    "refuses a %s handshake sentinel without contacting the origin",
    async (kind) => {
      if (kind !== "unknown") {
        proxy.registerRun(run, [
          {
            name: "SERVICE_KEY",
            sentinel,
            allowedHosts: kind === "unbound" ? [] : ["other.example"],
          },
        ]);
      }
      const credential =
        kind === "unknown"
          ? sealSecretSentinel("other-secret", { label: "unregistered" })
          : sentinel;
      const request = await rawUpgrade({ credential });
      await request.closed;
      expect(Buffer.concat(request.received).toString()).toMatch(/^HTTP\/1\.1 502 /);
      expect(observed).toEqual([]);
    },
  );

  it("preserves an upstream non-upgrade HTTP rejection", async () => {
    const request = await rawUpgrade({ pathname: "/reject" });
    await request.closed;
    expect(Buffer.concat(request.received).toString()).toMatch(/^HTTP\/1\.1 401 [\s\S]*denied$/);
    expect(observed).toEqual([
      { authorization: `Bearer ${value}`, url: "/reject", proxyAuth: undefined },
    ]);
    expect(auditEvents).toEqual([{ kind: "forwarded", host: "localhost", substituted: true }]);
  });

  it("audits a forwarded handshake and refusal when the upstream returns an invalid upgrade", async () => {
    const request = await rawUpgrade({ pathname: "/invalid-upgrade" });
    await request.closed;
    expect(Buffer.concat(request.received).toString()).toMatch(/^HTTP\/1\.1 502 /);
    expect(observed).toEqual([
      { authorization: `Bearer ${value}`, url: "/invalid-upgrade", proxyAuth: undefined },
    ]);
    expect(auditEvents).toEqual([
      { kind: "forwarded", host: "localhost", substituted: true },
      { kind: "refused", host: "localhost", substituted: true, reason: "upstream-error" },
    ]);
  });

  it("returns a bounded HTTP failure when the upstream resets during upgrade", async () => {
    const request = await rawUpgrade({ pathname: "/reset" });
    await request.closed;
    expect(Buffer.concat(request.received).toString()).toMatch(/^HTTP\/1\.1 502 /);
  });

  it("rejects an upgrade target outside the configured traffic allowlist", async () => {
    await proxy.stop();
    proxy = await startSecretEgressProxyServer({
      caDir,
      allowedHosts: ["localhost"],
      onAudit: () => {},
    });
    proxyEnv = proxy.registerRun(run);
    const request = await rawUpgrade({
      pathname: "https://other.example/socket",
      credential: "ordinary-value",
    });
    await request.closed;
    expect(Buffer.concat(request.received).toString()).toMatch(/^HTTP\/1\.1 403 /);
    expect(observed).toEqual([]);
  });

  it("does not open an opaque tunnel for a non-WebSocket upgrade", async () => {
    const request = await rawUpgrade({ upgrade: "another-protocol" });
    await request.closed;
    expect(Buffer.concat(request.received).toString()).toMatch(/^HTTP\/1\.1 400 /);
    expect(observed).toEqual([]);
  });

  it.each(["revocation", "client disconnect"])("aborts a pending upgrade on %s", async (action) => {
    const arrived = once(origin, "upgrade");
    const request = await rawUpgrade({ pathname: "/pending" });
    const [, originSocket] = await arrived;
    const originClosed = new Promise<void>((resolve) => {
      originSocket.once("close", resolve);
    });
    if (action === "revocation") {
      proxy.revokeRun(run);
    } else {
      request.socket.destroy();
    }
    await Promise.all([request.closed, originClosed]);
    expect(Buffer.concat(request.received)).toHaveLength(0);
  });

  it("forwards both head buffers without dropping the first WebSocket frames", async () => {
    const payload = Buffer.from("first-frame");
    const mask = Buffer.from([1, 2, 3, 4]);
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!)),
    ]);
    const request = await rawUpgrade({ head: frame });
    expect(await receive(request, "first-frame")).toMatch(/^HTTP\/1\.1 101 [\s\S]*ready/);
  });

  it("closes both ends of an established WebSocket when the owning run is revoked", async () => {
    const client = await websocket();
    await once(client, "message");
    const originClient = [...wss.clients][0]!;
    const originClosed = once(originClient, "close");
    const clientClosed = once(client, "close");
    proxy.revokeRun(run);
    await Promise.all([originClosed, clientClosed]);
    expect((await connectTunnel()).status).toBe(407);
  });
});
