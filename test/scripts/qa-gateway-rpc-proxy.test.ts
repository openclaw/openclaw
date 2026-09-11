import { once } from "node:events";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startQaGatewayRpcProxy } from "../fixtures/qa-gateway-rpc-proxy.mjs";
import { createDeferred } from "../helpers/promise.js";

type Proxy = Awaited<ReturnType<typeof startQaGatewayRpcProxy>>;

async function withProxy(
  setup: (server: Server, upstream: WebSocketServer) => void,
  run: (proxy: Proxy, connect: () => WebSocket) => Promise<void>,
) {
  const server = createServer();
  const upstream = new WebSocketServer({ noServer: true });
  const sockets = new Set<Duplex>();
  const socketClosures: Promise<void>[] = [];
  const clients: WebSocket[] = [];
  const clientClosures: Promise<void>[] = [];
  let proxy: Proxy | undefined;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socketClosures.push(
      new Promise((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
  });
  setup(server, upstream);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing backend listener");
    }
    proxy = await startQaGatewayRpcProxy({
      backendPort: address.port,
      repoRoot: path.resolve(import.meta.dirname, "../.."),
      upstreamHeaders: { "x-test-private-header": "synthetic-header-value" },
    });
    const activeProxy = proxy;
    await run(proxy, () => {
      const client = new WebSocket(activeProxy.url);
      clients.push(client);
      clientClosures.push(
        new Promise((resolve) => {
          client.once("close", () => resolve());
        }),
      );
      return client;
    });
  } finally {
    for (const client of clients) {
      client.terminate();
    }
    await Promise.all(clientClosures);
    await proxy?.stop();
    for (const client of upstream.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(socketClosures);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    expect(sockets.size).toBe(0);
    expect(upstream.clients.size).toBe(0);
    expect(clients.every((client) => client.readyState === WebSocket.CLOSED)).toBe(true);
  }
}

function expectBoundedDiagnostics(proxy: Proxy) {
  const entries = proxy.snapshot().firstConnection;
  expect(entries.length).toBeLessThanOrEqual(15);
  expect(new Set(entries.map((entry) => entry.tag)).size).toBe(entries.length);
  for (const entry of entries) {
    expect(
      Object.keys(entry).every((key) =>
        ["tag", "elapsedMs", "upstreamState", "httpStatus", "errorClass"].includes(key),
      ),
    ).toBe(true);
    expect(Number.isInteger(entry.elapsedMs) && entry.elapsedMs >= 0).toBe(true);
    if (entry.upstreamState !== undefined) {
      expect(["connecting", "open", "closing", "closed"]).toContain(entry.upstreamState);
    }
    if (entry.httpStatus !== undefined) {
      expect(Number.isInteger(entry.httpStatus)).toBe(true);
      expect(entry.httpStatus).toBeGreaterThanOrEqual(100);
      expect(entry.httpStatus).toBeLessThanOrEqual(599);
    }
    if (entry.errorClass !== undefined) {
      expect([
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "EPIPE",
        "EPROTO",
        "resource-exhausted",
        "opening-abort",
        "other",
      ]).toContain(entry.errorClass);
    }
  }
  expect(JSON.stringify(entries)).not.toMatch(/synthetic-|127\.0\.0\.1|__openclaw__|nonce|token/i);
  return entries;
}

describe("native Gateway proxy connection diagnostics", () => {
  it("preserves exact forwarding and headers while recording only the first connection", async () => {
    const challenge =
      '{"type":"event","event":"connect.challenge","payload":{"nonce":"synthetic-nonce"}}';
    const connectFrame =
      '{"type":"req","id":"connect-1","method":"connect","params":{"auth":{"token":"synthetic-token"}}}';
    const hello =
      '{"type":"res","id":"connect-1","ok":true,"payload":{"pluginSurfaceUrls":{"canvas":"http://127.0.0.1:1234/__openclaw__/cap/synthetic-ticket"}}}';
    const received: string[] = [];
    const headers: Array<string | string[] | undefined> = [];
    await withProxy(
      (server, upstream) => {
        server.on("upgrade", (request, socket, head) => {
          headers.push(request.headers["x-test-private-header"]);
          upstream.handleUpgrade(request, socket, head, (client) => {
            client.on("message", (raw) => {
              received.push(rawDataToString(raw));
              client.send(hello);
            });
            client.send(challenge);
          });
        });
      },
      async (proxy, connect) => {
        let first: ReturnType<Proxy["snapshot"]>["firstConnection"] | undefined;
        for (let index = 0; index < 2; index++) {
          const client = connect();
          const [rawChallenge] = await once(client, "message");
          expect(rawChallenge.toString()).toBe(challenge);
          const response = once(client, "message");
          client.send(connectFrame);
          const [rawHello] = await response;
          expect(rawHello.toString()).toBe(hello);
          const closed = once(client, "close");
          client.close();
          await closed;
          await expect
            .poll(() => proxy.snapshot().firstConnection.map((entry) => entry.tag))
            .toContain("upstream-close");
          const entries = expectBoundedDiagnostics(proxy);
          if (index === 0) {
            expect(entries.map((entry) => entry.tag)).toEqual(
              expect.arrayContaining([
                "front-open",
                "upstream-tcp-connected",
                "upstream-request-finished",
                "upstream-upgrade-received",
                "upstream-open",
                "challenge-received",
                "challenge-write-ok",
                "connect-received",
                "front-close",
                "upstream-close",
              ]),
            );
            expect(
              entries.find((entry) => entry.tag === "upstream-upgrade-received"),
            ).toMatchObject({ upstreamState: "connecting", httpStatus: 101 });
            first = entries;
          } else {
            expect(entries).toEqual(first);
          }
        }
        expect(received).toEqual([connectFrame, connectFrame]);
        expect(headers).toEqual(["synthetic-header-value", "synthetic-header-value"]);
        expect(proxy.snapshot().events.map((entry) => entry.kind)).toEqual([
          "connect-request",
          "connect-success",
          "connect-request",
          "connect-success",
        ]);
      },
    );
  });

  it("distinguishes caller cancellation while the upstream upgrade is withheld", async () => {
    const requested = createDeferred();
    await withProxy(
      (server) => server.on("upgrade", () => requested.resolve()),
      async (proxy, connect) => {
        const client = connect();
        await requested.promise;
        const closed = once(client, "close");
        client.close();
        await closed;
        await expect
          .poll(() => proxy.snapshot().firstConnection.map((entry) => entry.tag))
          .toContain("upstream-close");
        const entries = expectBoundedDiagnostics(proxy);
        expect(entries.map((entry) => entry.tag)).toEqual(
          expect.arrayContaining([
            "upstream-tcp-connected",
            "upstream-request-finished",
            "front-close",
          ]),
        );
        expect(entries.find((entry) => entry.tag === "upstream-error")).toMatchObject({
          upstreamState: "closing",
          errorClass: "opening-abort",
        });
        expect(entries.find((entry) => entry.tag === "front-close")).toMatchObject({
          upstreamState: "connecting",
        });
        expect(entries.map((entry) => entry.tag)).not.toContain("upstream-open");
        expect(entries.map((entry) => entry.tag)).not.toContain("upstream-upgrade-received");
        expect(proxy.snapshot().events).toEqual([]);
      },
    );
  });

  it.each([
    { status: 403, response: "HTTP/1.1 403 synthetic-denial\r\nContent-Length: 0\r\n\r\n" },
    {
      status: 101,
      response:
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: synthetic-invalid\r\n\r\n",
    },
  ])(
    "retains ws rejection and automatic closure for HTTP $status",
    async ({ status, response }) => {
      await withProxy(
        (server) => server.on("upgrade", (_request, socket) => socket.end(response)),
        async (proxy, connect) => {
          const client = connect();
          await once(client, "close");
          await expect
            .poll(() => proxy.snapshot().firstConnection.map((entry) => entry.tag))
            .toContain("upstream-close");
          const entries = expectBoundedDiagnostics(proxy);
          const tag = status === 101 ? "upstream-upgrade-received" : "upstream-http-response";
          expect(entries.find((entry) => entry.tag === tag)).toMatchObject({ httpStatus: status });
          expect(entries.find((entry) => entry.tag === "upstream-error")).toMatchObject({
            errorClass: "other",
          });
          expect(entries.map((entry) => entry.tag)).not.toContain("upstream-open");
          expect(entries.map((entry) => entry.tag)).not.toContain("challenge-received");
          expect(proxy.snapshot().events).toEqual([]);
        },
      );
    },
  );
});
