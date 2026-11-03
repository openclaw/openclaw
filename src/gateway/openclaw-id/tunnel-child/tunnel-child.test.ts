import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  CONNECTION_CLOSE,
  STREAM_RESET,
  syntheticPeerAddress,
  type IrohEndpointKey,
} from "../../../../packages/openclaw-id-protocol/src/index.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../../../infra/runtime-worker-url.js";
import type { TunnelReadyMessage } from "../tunnel-ipc.js";
import { createTunnelSupervisor, type TunnelSupervisor } from "../tunnel-supervisor.js";
import { loadIrohBinding, type IrohBinding } from "./addon.js";
import { createTunnelTestClient } from "./tunnel-client.test-support.js";

// Runs the real tunnel child (production entry, supervisor launch path) against a
// stand-in Gateway on a Unix socket. Needs the iroh binding; skipped without it.
let binding: IrohBinding | undefined;
try {
  binding = loadIrohBinding();
} catch {
  binding = undefined;
}

const PROXY_TOKEN = "per-boot-token-for-tests-0123456789abcdef";
const seen: http.IncomingMessage[] = [];
let inFlight = 0;
let maxInFlight = 0;
let dir: string;
let upstream: http.Server;
let supervisor: TunnelSupervisor;
let ready: TunnelReadyMessage;

beforeAll(async () => {
  if (!binding) {
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-id-child-"));
  const socketPath = path.join(dir, "ingress.sock");
  upstream = http.createServer((req, res) => {
    seen.push(req);
    if (req.url === "/gzip") {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      res.end(gzipSync(Buffer.from("compressed hello")));
      return;
    }
    if (req.url === "/slow") {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        res.end("slow");
      }, 300);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.concat(chunks));
    });
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(socketPath, resolve);
  });
  const entry = resolveRuntimeProcessEntrypointUrl("openclawIdTunnel");
  const onReady = vi.fn();
  supervisor = createTunnelSupervisor({
    launch: { entry, execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1) },
    startMessage: () => ({
      type: "start",
      relayUrl: "http://127.0.0.1:9/",
      keyPath: path.join(dir, "iroh", "endpoint.key"),
      bindAddr: "127.0.0.1:0",
      ingress: { socketPath, proxyToken: PROXY_TOKEN },
      forwardedProto: "https",
    }),
    log: { info: () => {}, warn: () => {} },
    onReady,
  });
  supervisor.start();
  await vi.waitFor(() => expect(onReady).toHaveBeenCalled(), { timeout: 20_000 });
  ready = onReady.mock.calls[0]![0] as TunnelReadyMessage;
}, 30_000);

afterAll(async () => {
  await supervisor?.stop();
  upstream?.close();
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function admittedClient() {
  const client = await createTunnelTestClient(binding!);
  supervisor.pushMembership(1, [client.peerKey]);
  await sleep(50);
  return { client, session: await client.connect(ready.endpointKey, ready.directAddrs) };
}

describe.skipIf(!binding)("tunnel child", () => {
  it("creates a private endpoint key and reports K_srv", () => {
    expect(ready.endpointKey).toMatch(/^iroh:[0-9a-f]{64}$/);
    expect(ready.keyCreated).toBe(true);
    const stat = fs.statSync(path.join(dir, "iroh", "endpoint.key"));
    expect(stat.mode & 0o077).toBe(0);
  });

  it("refuses a peer that is not admitted before any stream", async () => {
    const client = await createTunnelTestClient(binding!);
    try {
      const { conn } = await client.connect(ready.endpointKey, ready.directAddrs);
      const closed = await conn.closed();
      expect(closed.code).toBe(CONNECTION_CLOSE.not_a_member);
    } finally {
      await client.close();
    }
  });

  it("proxies HTTP with ingress facts and strips client identity headers", async () => {
    const { client, session } = await admittedClient();
    try {
      const body = Buffer.from("request body");
      const response = await session.http(
        "POST",
        "/echo?x=1",
        [
          ["host", "claw.example.test"],
          ["origin", "https://claw.example.test"],
          ["x-forwarded-user", "mallory"],
          ["x-openclaw-id-peer-key", "iroh:" + "00".repeat(32)],
          ["x-openclaw-id-proxy-token", "forged"],
          ["x-forwarded-for", "127.0.0.1"],
          ["forwarded", "for=127.0.0.1"],
        ],
        body,
      );
      expect(response.head.status).toBe(200);
      expect(response.body).toEqual(body);
      const req = seen.at(-1)!;
      expect(req.headers["x-openclaw-id-peer-key"]).toBe(client.peerKey);
      expect(req.headers["x-openclaw-id-proxy-token"]).toBe(PROXY_TOKEN);
      expect(req.headers["x-forwarded-for"]).toBe(
        await syntheticPeerAddress(client.peerKey as IrohEndpointKey),
      );
      expect(req.headers["x-forwarded-proto"]).toBe("https");
      expect(req.headers["x-forwarded-host"]).toBe("claw.example.test");
      expect(req.headers.host).toBe("claw.example.test");
      expect(req.headers.origin).toBe("https://claw.example.test");
      expect(req.headers["x-forwarded-user"]).toBeUndefined();
      expect(req.headers.forwarded).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("passes gzip responses through byte for byte", async () => {
    const { client, session } = await admittedClient();
    try {
      const response = await session.http("GET", "/gzip", [["accept-encoding", "gzip"]]);
      expect(response.head.headers).toContainEqual(["content-encoding", "gzip"]);
      expect(response.body).toEqual(gzipSync(Buffer.from("compressed hello")));
    } finally {
      await client.close();
    }
  });

  it("proxies WebSocket messages both ways", async () => {
    const { client, session } = await admittedClient();
    try {
      const ws = await session.ws("/ws", [["origin", "https://claw.example.test"]]);
      expect(ws.head?.status).toBe(101);
      await ws.send({ op: "text", data: new TextEncoder().encode("ping") });
      const reply = await ws.next();
      expect(reply?.op).toBe("text");
      expect(reply && reply.op !== "close" && Buffer.from(reply.data).toString()).toBe("ping");
      await ws.send({ op: "close", code: 1000, reason: "bye" });
      expect(await ws.next()).toMatchObject({ op: "close", code: 1000 });
    } finally {
      await client.close();
    }
  });

  it("serves at most 64 streams at once and queues the rest", async () => {
    const { client, session } = await admittedClient();
    try {
      maxInFlight = 0;
      const responses = await Promise.all(
        Array.from({ length: 70 }, () => session.http("GET", "/slow", [])),
      );
      expect(responses.every((response) => response.head.status === 200)).toBe(true);
      expect(maxInFlight).toBe(64);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("resets a stream with a malformed HEAD", async () => {
    const { client, session } = await admittedClient();
    try {
      const recv = await session.raw(Buffer.from([0, 0, 0, 2, 0x7b, 0x7d]));
      await expect(recv.read(1024)).rejects.toThrow(String(STREAM_RESET.bad_request));
    } finally {
      await client.close();
    }
  });

  it("closes a live connection with revoked when membership drops the key", async () => {
    const { client, session } = await admittedClient();
    try {
      // connect() resolves before the server admits; one exchange proves admission.
      expect((await session.http("GET", "/echo", [])).head.status).toBe(200);
      supervisor.pushMembership(2, []);
      const closed = await session.conn.closed();
      expect(closed.code).toBe(CONNECTION_CLOSE.revoked);
    } finally {
      await client.close();
    }
  });
});
