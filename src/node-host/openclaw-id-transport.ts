import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "../../packages/gateway-client/src/websocket.js";
import {
  CLIENT_KEEP_ALIVE_MS,
  decodeWsMessage,
  encodeHead,
  encodeWsMessage,
  HTTP_STREAM_IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_HEAD_FRAME_BYTES,
  MAX_HTTP_DATA_FRAME_BYTES,
  parseResponseHead,
  STREAM_RESET,
  verifyBindingForPin,
  type HeaderPair,
  type TunnelRequestHead,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { resolveStateDir } from "../config/paths.js";
import { loadIrohBinding } from "../gateway/openclaw-id/tunnel-child/addon.js";
import {
  FrameReader,
  writeDataFrames,
  writeFrame,
} from "../gateway/openclaw-id/tunnel-child/frames.js";
import { loadOrCreateEndpointKey } from "../gateway/openclaw-id/tunnel-child/keyfile.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { NodeTunnelConnection } from "./openclaw-id-connection.js";
import type { NodeHostOpenClawIdTarget } from "./openclaw-id-target.js";

/** W is never serialized into config, a worker descriptor or a subprocess environment. */
export function loadNodeTunnelKey(stateDir = resolveStateDir()): Buffer {
  return loadOrCreateEndpointKey(path.join(stateDir, "node-openclaw-id", "endpoint.key")).key;
}

function requestHeaders(raw: string[]): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    pairs.push([raw[i]!, raw[i + 1]!]);
  }
  return pairs;
}

/** A private Unix bridge lets worker processes share W without receiving its key. */
export async function startNodeTunnelTransport(options: {
  target: NodeHostOpenClawIdTarget;
  stateDir?: string;
  directAddrs?: string[];
  onTerminal: (error: Error) => void;
}) {
  if (process.platform === "win32") {
    throw new Error("Labs OpenClaw ID node transport currently requires Unix sockets");
  }
  const verified = await verifyBindingForPin(options.target.evidence, options.target.pin, {
    host: options.target.hostname,
    now: Math.floor(Date.now() / 1000),
  });
  if (!verified.ok) {
    throw new Error(`OpenClaw ID node binding rejected: ${verified.code}`);
  }
  if (verified.pin.binding_seq !== options.target.pin.binding_seq) {
    throw new Error(
      "OpenClaw ID binding changed; persist the verified enrollment pin before connecting",
    );
  }
  const binding = loadIrohBinding();
  const endpoint = await binding.bind({
    secretKey: loadNodeTunnelKey(options.stateDir),
    relayUrl: options.target.relayUrl,
    ipTransports: true,
    keepAliveMs: CLIENT_KEEP_ALIVE_MS,
  });
  const session = new NodeTunnelConnection({
    endpoint,
    serverKey: verified.binding.k_srv,
    relayUrl: options.target.relayUrl,
    directAddrs: options.directAddrs,
    onTerminal: options.onTerminal,
  });
  // Short temp path fits sockaddr_un. mkdtemp is 0700 before either listener exists.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-node-"));
  await fs.chmod(dir, 0o700);
  const socketPath = path.join(dir, "gateway.sock");
  // OS socket errors include this path; register before any operation can emit one.
  registerSecretValueForRedaction(socketPath);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  const open = async (head: TunnelRequestHead) => {
    const conn = await session.connection();
    const stream = await conn.openBi();
    const reader = new FrameReader(stream.recv);
    await writeFrame(stream.send, encodeHead(head));
    const next = async (limit?: number) => {
      const frame = await reader.next(limit);
      session.received();
      return frame;
    };
    return { ...stream, next };
  };
  const server = http.createServer((req, res) => {
    res.setTimeout(HTTP_STREAM_IDLE_TIMEOUT_MS, () => res.destroy());
    void (async () => {
      const stream = await open({
        kind: "http",
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: requestHeaders(req.rawHeaders),
      });
      const abort = new AbortController();
      const cancel = () => {
        abort.abort();
        void stream.recv.stop(STREAM_RESET.bad_request).catch(() => {});
        void stream.send.reset(STREAM_RESET.bad_request).catch(() => {});
      };
      res.once("close", cancel);
      if (res.destroyed) {
        cancel();
        return;
      }
      let completed = false;
      const sent = (async () => {
        for await (const chunk of req) {
          await writeDataFrames(stream.send, Buffer.from(chunk));
        }
        await stream.send.finish();
      })();
      void sent.catch(() => {
        if (!completed) {
          res.destroy();
        }
      });
      try {
        const frame = await stream.next(MAX_HEAD_FRAME_BYTES);
        if (!frame) {
          throw new Error("missing tunnel response HEAD");
        }
        const head = parseResponseHead(frame);
        if (!("headers" in head)) {
          throw new Error("unexpected WebSocket response");
        }
        res.writeHead(head.status, head.headers.flat());
        for (
          let data = await stream.next(MAX_HTTP_DATA_FRAME_BYTES);
          data !== null;
          data = await stream.next(MAX_HTTP_DATA_FRAME_BYTES)
        ) {
          if (!res.write(data)) {
            await once(res, "drain", { signal: abort.signal });
          }
        }
        completed = true;
        res.end();
      } finally {
        cancel();
        if (!req.complete) {
          res.once("finish", () => req.destroy());
        }
      }
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("OpenClaw ID tunnel unavailable");
      } else {
        res.destroy();
      }
    });
  });
  server.on("upgrade", (req, socket, upgradeHead) => {
    socket.on("error", () => {});
    void (async () => {
      const stream = await open({
        kind: "ws",
        path: req.url ?? "/",
        headers: requestHeaders(req.rawHeaders),
        protocols: [],
      });
      const cancel = () => {
        void stream.recv.stop(STREAM_RESET.bad_request).catch(() => {});
        void stream.send.reset(STREAM_RESET.bad_request).catch(() => {});
      };
      socket.once("close", cancel);
      if (socket.destroyed) {
        cancel();
        return;
      }
      const frame = await stream.next(MAX_HEAD_FRAME_BYTES);
      if (!frame) {
        throw new Error("missing tunnel response HEAD");
      }
      const head = parseResponseHead(frame);
      if (socket.destroyed) {
        cancel();
        return;
      }
      if (head.status !== 101) {
        socket.end(
          `HTTP/1.1 ${head.status} Tunnel refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        cancel();
        return;
      }
      wss.handleUpgrade(req, socket, upgradeHead, (ws) => {
        let tail = Promise.resolve();
        let queued = 0;
        ws.on("error", cancel);
        ws.on("message", (data, binary) => {
          if (++queued >= 16) {
            ws.pause();
          }
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
          tail = tail
            .then(() =>
              writeFrame(
                stream.send,
                encodeWsMessage({ op: binary ? "binary" : "text", data: bytes }),
              ),
            )
            .catch(() => ws.terminate())
            .finally(() => {
              if (--queued < 4) {
                ws.resume();
              }
            });
        });
        ws.on("close", (code, reason) => {
          tail = tail
            .then(async () => {
              await writeFrame(
                stream.send,
                encodeWsMessage({ op: "close", code, reason: reason.toString() }),
              );
              await stream.send.finish();
            })
            .catch(() => {});
        });
        void (async () => {
          for (let data = await stream.next(); data !== null; data = await stream.next()) {
            const message = decodeWsMessage(data);
            if (message.op === "close") {
              const code = message.code;
              if (
                code !== null &&
                ((code >= 1000 && code <= 1003) ||
                  (code >= 1007 && code <= 1014) ||
                  (code >= 3000 && code <= 4999))
              ) {
                ws.close(code, message.reason);
              } else {
                ws.close();
              }
              return;
            }
            if (ws.readyState !== WebSocket.OPEN) {
              return;
            }
            await new Promise<void>((resolve, reject) => {
              ws.send(message.data, { binary: message.op === "binary" }, (error) =>
                error ? reject(error) : resolve(),
              );
            });
          }
          ws.terminate();
        })().catch(() => ws.terminate());
      });
    })().catch(() => socket.destroy());
  });
  try {
    server.listen(socketPath);
    await once(server, "listening");
    await fs.chmod(socketPath, 0o600);
  } catch (error) {
    await session.close();
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
  const url = `ws+unix:${socketPath}:/`;
  return {
    url,
    formatDiagnostic(message: string): string {
      const kind = session.pathKind();
      const route = kind === "direct" ? "direct" : kind === "relay" ? "relayed" : "not connected";
      const target = `${options.target.hostname} via OpenClaw ID (${route})`;
      return message.replaceAll(url, target).replaceAll(socketPath, target);
    },
    peerKey: `iroh:${endpoint.id()}`,
    async close() {
      for (const ws of wss.clients) {
        ws.terminate();
      }
      server.closeAllConnections();
      await session.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      wss.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
