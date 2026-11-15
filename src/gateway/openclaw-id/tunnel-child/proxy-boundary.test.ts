import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFrame } from "../../../../packages/openclaw-id-protocol/src/index.js";
import { readGatewayIngressTransport } from "../../ingress-attribution.js";
import {
  startOpenClawIdIngressListener,
  type OpenClawIdIngressListener,
} from "../ingress-listener.js";
import { FrameReader } from "./frames.js";
import { upstreamHeaders } from "./headers.js";
import { proxyHttp } from "./http-proxy.js";
import { proxyWs } from "./ws-proxy.js";

const attacker = `iroh:${"a".repeat(64)}`;
const owner = `iroh:${"b".repeat(64)}`;
const send = {
  write: async (_bytes: Uint8Array) => {},
  finish: async () => {},
  reset: async (_code: number) => {},
};

function frameReader(...frames: Buffer[]): FrameReader {
  const wire = Buffer.concat(frames.map((frame) => Buffer.from(encodeFrame(frame))));
  let read = false;
  return new FrameReader({
    read: async () => {
      if (read) {
        return null;
      }
      read = true;
      return wire.length ? wire : null;
    },
    stop: async () => {},
  });
}

describe("tunnel proxy boundary", () => {
  let dir: string;
  let listener: OpenClawIdIngressListener;
  let gateway: http.Server;
  let decoy: http.Server;
  const requests: Array<{
    path: string | undefined;
    peer: string | undefined;
    body: string;
    socket: object;
    contentLength: string | undefined;
    transferEncoding: string | undefined;
  }> = [];
  const upgrades: Array<{ path: string | undefined; host: string | undefined }> = [];
  const decoyUpgrades: string[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-id-proxy-"));
    gateway = http.createServer((req, res) => {
      const transport = readGatewayIngressTransport(req);
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          path: req.url,
          peer: transport?.kind === "openclaw-id-tunnel" ? transport.peerKey : undefined,
          body: Buffer.concat(chunks).toString(),
          socket: req.socket,
          contentLength: req.headers["content-length"],
          transferEncoding: req.headers["transfer-encoding"],
        });
        res.end("ok");
      });
    });
    gateway.on("upgrade", (req, socket) => {
      upgrades.push({ path: req.url, host: req.headers.host });
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    listener = await startOpenClawIdIngressListener({
      socketPath: path.join(dir, "ingress.sock"),
      gatewayServer: () => gateway,
      log: { warn: () => {} },
    });
    decoy = http.createServer();
    decoy.on("upgrade", (req, socket) => {
      decoyUpgrades.push(req.url ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => {
      decoy.listen(path.join(dir, "other.sock"), resolve);
    });
  });

  afterAll(async () => {
    await listener?.close();
    await new Promise<void>((resolve) => {
      decoy?.close(() => resolve());
    });
    gateway?.closeAllConnections();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function headers(peerKey: string, clientHeaders: Array<[string, string]> = []) {
    return upstreamHeaders(
      clientHeaders,
      {
        peerKey,
        proxyToken: listener.proxyToken,
        peerAddress: "fd69:726f:6800:1:2:3:4:5",
        forwardedProto: "https",
      },
      "http",
    );
  }

  it("keeps two peers' HTTP requests on one connection with their own paths and bodies", async () => {
    const injected = "AGET /forged HTTP/1.1\r\nX-Note: ";
    expect(
      await proxyHttp({
        head: { kind: "http", method: "POST", path: "/first", headers: [] },
        reader: frameReader(Buffer.from(injected)),
        send,
        headers: headers(attacker, [["Content-Length", "1"]]),
        target: listener,
      }),
    ).toBe(200);
    expect(
      await proxyHttp({
        head: { kind: "http", method: "GET", path: "/owner", headers: [] },
        reader: frameReader(),
        send,
        headers: headers(owner),
        target: listener,
      }),
    ).toBe(200);
    expect(
      requests.slice(0, 2).map(({ path: requestPath, peer, body }) => ({
        path: requestPath,
        peer,
        body,
      })),
    ).toEqual([
      { path: "/first", peer: attacker, body: injected },
      { path: "/owner", peer: owner, body: "" },
    ]);
    expect(requests[0]?.socket).toBe(requests[1]?.socket);
    expect(
      requests
        .slice(0, 2)
        .map(({ contentLength, transferEncoding }) => ({ contentLength, transferEncoding })),
    ).toEqual([
      { contentLength: undefined, transferEncoding: "chunked" },
      { contentLength: undefined, transferEncoding: "chunked" },
    ]);
  });

  it.each(["GET", "HEAD", "DELETE", "OPTIONS", "TRACE"])(
    "frames a %s body instead of sending its bytes as another request",
    async (method) => {
      expect(
        await proxyHttp({
          head: { kind: "http", method, path: "/with-body", headers: [] },
          reader: frameReader(Buffer.from("body bytes")),
          send,
          headers: headers(attacker),
          target: listener,
        }),
      ).toBe(200);
      expect(requests.at(-1)).toMatchObject({
        path: "/with-body",
        peer: attacker,
        body: "body bytes",
      });
    },
  );

  it("pins WebSocket upgrades to the configured socket", async () => {
    for (const requestPath of [
      "/../other.sock:/ws",
      "/%2e%2e/other.sock:/ws",
      "/.%2E/other.sock:/ws",
      "/ws?session=agent:main:main",
    ]) {
      expect(
        await proxyWs({
          head: { kind: "ws", path: requestPath, headers: [], protocols: [] },
          reader: frameReader(),
          send,
          headers: upstreamHeaders(
            [],
            {
              peerKey: attacker,
              proxyToken: listener.proxyToken,
              peerAddress: "fd69:726f:6800:1:2:3:4:5",
              forwardedProto: "https",
            },
            "ws",
          ),
          target: listener,
        }),
      ).toBe(403);
    }
    expect(decoyUpgrades).toEqual([]);
    expect(upgrades).toEqual([
      { path: "/other.sock:/ws", host: "localhost" },
      { path: "/other.sock:/ws", host: "localhost" },
      { path: "/other.sock:/ws", host: "localhost" },
      { path: "/ws?session=agent:main:main", host: "localhost" },
    ]);
  });
});
