import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { afterEach, expect } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { hasErrnoCode } from "../infra/errno.js";

export const TICKET = "a".repeat(48);
export function streamParams(kind: "desktop" | "portal", overrides: object = {}) {
  return JSON.stringify({
    ticket: TICKET,
    attachPath: `/node-${kind}/attach?ticket=${TICKET}`,
    ...overrides,
  });
}

export function portOf(server: net.Server) {
  const address = server.address();
  assert(address && typeof address !== "string", "expected local test address");
  return address.port;
}

/** IPv6 is unavailable in some containers. Other listen failures still fail the test. */
export async function listen(
  server: net.Server,
  options: net.ListenOptions = { host: "127.0.0.1", port: 0 },
) {
  return await new Promise<boolean>((resolve, reject) => {
    const onError = (error: Error) =>
      hasErrnoCode(error, "EAFNOSUPPORT") || hasErrnoCode(error, "EADDRNOTAVAIL")
        ? resolve(false)
        : reject(error);
    server.once("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resolve(true);
    });
  });
}

export function useStreamFixture() {
  const cleanups: Array<() => Promise<void>> = [];
  const onCleanup = (close: (done: () => void) => void) => {
    cleanups.push(() => new Promise<void>(close));
  };
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });
  return {
    cleanups,
    closeServer: (server: net.Server, peers: Iterable<{ destroy(): void }> = []) => {
      onCleanup((done) => {
        for (const peer of peers) {
          peer.destroy();
        }
        server.close(() => done());
      });
    },
    gateway: async (_kind: "portal", contextPath = "") => {
      const peer: {
        socket?: WebSocket;
        headers: Array<string | undefined>;
        frames: Buffer[];
        closed: boolean;
      } = { headers: [], frames: [], closed: false };
      const server = http.createServer();
      // Reserve both families so the Gateway cannot steal an IPv6 target's IPv4 port.
      if (!(await listen(server, { port: 0, host: "::", ipv6Only: false }))) {
        await listen(server);
      }
      const wss = new WebSocketServer({
        server,
        path: `${contextPath.replace(/\/$/u, "")}/node-portal/attach`,
      });
      wss.on("connection", (ws, request) => {
        peer.socket = ws;
        peer.headers = ["cf-access-client-id", "cf-access-client-secret"].map((name) =>
          request.headers[name]?.toString(),
        );
        ws.on("message", (data, binary) => {
          expect(binary).toBe(true);
          assert(Buffer.isBuffer(data), "expected stream frame buffer");
          peer.frames.push(data);
        });
        ws.once("close", () => {
          peer.closed = true;
        });
      });
      onCleanup((done) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => server.close(() => done()));
      });
      return { peer, gatewayUrl: `ws://127.0.0.1:${portOf(server)}${contextPath}` };
    },
  };
}
