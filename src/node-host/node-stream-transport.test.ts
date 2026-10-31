import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { installGlobalProxy } from "@openclaw/proxyline";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { WebSocket } from "../../packages/gateway-client/src/websocket.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { runNodeStreamTransport } from "./node-stream-transport.js";

type StreamOptions = Parameters<typeof runNodeStreamTransport>[0];
function runStream(
  options: Pick<StreamOptions, "gatewayUrl" | "target" | "signal"> & Partial<StreamOptions>,
) {
  return runNodeStreamTransport({
    attachPath: "/node-desktop/attach",
    expectedAttachPath: "/node-desktop/attach",
    metadata: { ok: true },
    streamName: "desktop",
    ...options,
  });
}
async function listenServer(server: net.Server) {
  await once(server.listen(0, "127.0.0.1"), "listening");
  return (server.address() as AddressInfo).port;
}
async function close(server: net.Server | WebSocketServer) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
async function connectTarget(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  return socket;
}
function targetStream() {
  return new Duplex({
    read() {},
    write: (_chunk, _encoding, callback) => callback(),
  });
}
async function streamHarness(
  server: net.Server,
  target = targetStream(),
  closePeers?: () => void | Promise<void>,
) {
  const gatewayUrl = `ws://127.0.0.1:${await listenServer(server)}`;
  const controller = new AbortController();
  return {
    target,
    controller,
    run: (options: Partial<StreamOptions> = {}) =>
      runStream({ gatewayUrl, target: { stream: target }, signal: controller.signal, ...options }),
    async cleanup() {
      controller.abort();
      target.destroy();
      await closePeers?.();
      await close(server);
    },
    async [Symbol.asyncDispose]() {
      await this.cleanup();
    },
  };
}
async function websocketHarness(onConnection?: (ws: WebSocket) => void, target?: Duplex) {
  const server = createHttpServer();
  const wss = new WebSocketServer({ server });
  if (onConnection) {
    wss.on("connection", onConnection);
  }
  const harness = await streamHarness(server, target, async () => {
    for (const client of wss.clients) {
      client.terminate();
    }
    await close(wss);
  });
  return { ...harness, wss };
}
// Raw peers deliberately leave the websocket/TCP close handshake incomplete.
function rawGateway(onFrame: (socket: net.Socket) => void, onPeer?: (socket: net.Socket) => void) {
  return net.createServer({ allowHalfOpen: Boolean(onPeer) }, (socket) => {
    onPeer?.(socket);
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) {
        onFrame(socket);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const key = /^Sec-WebSocket-Key: ([^\r\n]+)/m
        .exec(buffer.subarray(0, headerEnd).toString("latin1"))?.[1]
        ?.trim();
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      upgraded = true;
      if (!onPeer && buffer.length > headerEnd + 4) {
        onFrame(socket);
      }
    });
  });
}
async function rawFrameHarness(frame: number[], onPeer?: (socket: net.Socket) => void) {
  let peer: net.Socket | undefined;
  let sent = false;
  const server = rawGateway(
    (socket) => {
      if (!sent) {
        sent = true;
        socket.write(Buffer.from(frame));
      }
    },
    (socket) => {
      peer = socket;
      onPeer?.(socket);
    },
  );
  const destroyPeer = () => {
    peer?.destroy();
  };
  return { ...(await streamHarness(server, undefined, destroyPeer)), destroyPeer };
}

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const ticket = "1".repeat(48);
const logPaths = createSuiteLogPathTracker("node-stream-diagnostics-");
const logCaptures: ReturnType<typeof createDiagnosticLogRecordCapture>[] = [];
const STREAM_CLOSED = "node stream closed";

beforeAll(async () => logPaths.setup());
beforeEach(() =>
  setLoggerOverride({ level: "info", consoleLevel: "silent", file: logPaths.nextPath() }),
);
afterEach(async () => {
  try {
    await flushLogger();
    for (const capture of logCaptures) {
      await capture.flush();
    }
  } finally {
    for (const capture of logCaptures.splice(0)) {
      capture.cleanup();
    }
    resetLogger();
  }
});
afterAll(async () => logPaths.cleanup());

describe.each([false, true])("node stream TLS (managed proxy: %s)", (managed) => {
  it.each([
    ...["desktop", "portal"].flatMap((streamName) =>
      (["target-eof", "gateway-close", "gateway-terminate", "owner-abort"] as const)
        .filter((closeMode) => closeMode === "target-eof" || (!managed && streamName === "desktop"))
        .map((closeMode) => ({ streamName, closeMode, correctPin: true, tls: true })),
    ),
    { streamName: "desktop", correctPin: false, tls: true, closeMode: "target-eof" },
    { streamName: "portal", correctPin: false, tls: true, closeMode: "target-eof" },
    { streamName: "desktop", correctPin: false, tls: false, closeMode: "target-eof" },
    { streamName: "portal", correctPin: false, tls: false, closeMode: "target-eof" },
  ])(
    "validates $streamName and records $closeMode (correct pin: $correctPin, TLS: $tls)",
    async ({ streamName, correctPin, tls, closeMode }) => {
      const logCapture = createDiagnosticLogRecordCapture();
      logCaptures.push(logCapture);
      const sockets = new Set<net.Socket>();
      const servers: net.Server[] = [];
      const track = (socket: net.Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      };
      const listen = async (server: net.Server) => {
        servers.push(server);
        server.on("connection", track);
        return listenServer(server);
      };
      const localPort = await listen(
        net.createServer((socket) => {
          socket.on("data", (chunk) => {
            if (closeMode === "target-eof") {
              socket.end(chunk);
            } else {
              socket.write(chunk);
            }
          });
        }),
      );
      const gateway = tls
        ? createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM })
        : createHttpServer();
      let bytes = 0;
      gateway.on(tls ? "secureConnection" : "connection", (socket: net.Socket) => {
        socket.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
      });
      const wss = new WebSocketServer({ server: gateway });
      const frames: string[] = [];
      const accessHeaders: unknown[] = [];
      wss.on("connection", (ws, request) => {
        accessHeaders.push(request.headers["cf-access-client-secret"]);
        ws.on("message", (data) => {
          frames.push(rawDataToString(data));
          if (frames.length === 1) {
            ws.send(Buffer.from("stream-echo"));
          }
        });
      });
      const gatewayPort = await listen(gateway);
      const proxyServer = createHttpServer();
      let tunnels = 0;
      proxyServer.on("connect", (_request, downstream, head) => {
        tunnels++;
        const upstream = net.connect(gatewayPort, "127.0.0.1", () => {
          downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          downstream.pipe(upstream).pipe(downstream);
        });
        track(upstream);
        downstream.on("error", () => upstream.destroy());
        upstream.on("error", () => downstream.destroy());
        downstream.once("close", () => upstream.destroy());
        upstream.once("close", () => downstream.destroy());
      });
      const proxyPort = managed ? await listen(proxyServer) : undefined;
      const proxy = managed
        ? installGlobalProxy({ mode: "managed", proxyUrl: `http://127.0.0.1:${proxyPort}` })
        : undefined;
      const controller = new AbortController();
      let failure: unknown;
      const running = runStream({
        gatewayUrl: `${tls ? "wss" : "ws"}://127.0.0.1:${gatewayPort}`,
        gatewayTlsFingerprint: correctPin ? fingerprint : "ab".repeat(32),
        gatewayCloudflareAccess: {
          clientId: "fixture-client-id",
          clientSecret: "fixture-client-secret",
        },
        attachPath: `/node-${streamName}/attach?ticket=${ticket}`,
        expectedAttachPath: `/node-${streamName}/attach`,
        target:
          streamName === "portal"
            ? { port: localPort }
            : { stream: await connectTarget(localPort) },
        streamName,
        signal: controller.signal,
      }).catch((error: unknown) => {
        failure = error;
      });
      try {
        if (correctPin) {
          if (closeMode === "target-eof") {
            await running;
          } else {
            await expect.poll(() => frames).toEqual([JSON.stringify({ ok: true }), "stream-echo"]);
          }
          expect(accessHeaders).toEqual(["fixture-client-secret"]);
          if (closeMode === "owner-abort") {
            controller.abort();
          } else if (closeMode !== "target-eof") {
            for (const peer of wss.clients) {
              if (closeMode === "gateway-close") {
                peer.close(1012, `peer restart\n${ticket} fixture-client-secret`);
              } else {
                peer.terminate();
              }
            }
          }
          await running;
          expect(frames).toEqual([JSON.stringify({ ok: true }), "stream-echo"]);
          await expect
            .poll(async () => {
              await logCapture.flush();
              return logCapture.records.filter((record) => record.message === STREAM_CLOSED);
            })
            .toHaveLength(1);
          const trigger =
            closeMode === "owner-abort"
              ? "owner-abort"
              : closeMode === "target-eof"
                ? "target-close"
                : "websocket-close";
          const closeCode =
            closeMode === "gateway-close" ? 1012 : closeMode === "target-eof" ? 1005 : 1006;
          const terminalRecord = logCapture.records.find(
            (record) => record.message === STREAM_CLOSED,
          );
          expect(terminalRecord?.attributes).toMatchObject({
            streamKind: streamName,
            trigger,
            closeCode,
          });
          expect(terminalRecord?.attributes?.closeReason).toBeUndefined();
          expect(failure).toBeUndefined();
          const serialized = JSON.stringify(logCapture.records);
          expect(serialized).not.toContain(ticket);
          expect(serialized).not.toMatch(
            /peer restart|fixture-client-secret|stream-echo|attach\?ticket=/,
          );
        } else {
          await expect.poll(() => failure).toBeInstanceOf(Error);
          expect(String(failure)).toMatch(/fingerprint (?:mismatch|unavailable)/i);
        }
        controller.abort();
        await running;
        await expect.poll(() => sockets.size).toBe(0);
        if (!correctPin) {
          expect([bytes, frames, accessHeaders]).toEqual([0, [], []]);
        }
        expect(tunnels).toBe(managed ? 1 : 0);
      } finally {
        controller.abort();
        await running;
        proxy?.stop();
        for (const socket of sockets) {
          socket.destroy();
        }
        await close(wss);
        for (const server of servers.toReversed()) {
          await close(server);
        }
      }
    },
  );
});

it.each([
  ["malformed URL", { gatewayUrl: "not-a-url" }],
  ["cross-origin attachment", { attachPath: "ws://example.invalid/node-desktop/attach" }],
  ["constructor rejects fragment", { attachPath: "/node-desktop/attach#invalid" }],
  [
    "constructor rejects header",
    { gatewayCloudflareAccess: { clientId: "invalid\nheader", clientSecret: "fixture" } },
  ],
])("closes its connected target when %s fails", async (_name, override) => {
  const peerClosed = createDeferred();
  const local = net.createServer((peer) => peer.once("close", () => peerClosed.resolve()));
  const port = await listenServer(local);
  const socket = await connectTarget(port);
  try {
    await expect(
      runStream({
        gatewayUrl: "ws://127.0.0.1:1",
        target: { stream: socket },
        metadata: { auth: "vnc-password" },
        signal: new AbortController().signal,
        ...override,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(socket.destroyed).toBe(true);
    await peerClosed.promise;
  } finally {
    socket.destroy();
    await close(local);
  }
});
it("settles after the target closes before drain", async () => {
  const wrote = createDeferred();
  let writes = 0;
  const target = new Duplex({
    highWaterMark: 1,
    read() {},
    write(_chunk, _encoding, _callback) {
      // The target closes with a write pending, so it will never emit drain.
      writes++;
      wrote.resolve();
    },
  });
  target.once("end", () => target.destroy());
  const frames: string[] = [];
  await using harness = await websocketHarness((ws) => {
    ws.on("message", (data) => {
      frames.push(rawDataToString(data));
      if (frames.length === 1) {
        ws.send(Buffer.from("pending-target-write"));
      } else {
        ws.send(Buffer.from("late-target-write"));
      }
    });
  }, target);
  let settled = false;
  const running = harness.run().then(() => {
    settled = true;
  });
  try {
    await wrote.promise;
    target.push(Buffer.from("terminal-response"));
    target.push(null);
    await expect.poll(() => settled).toBe(true);
    await running;
    expect(frames).toEqual([JSON.stringify({ ok: true }), "terminal-response"]);
    expect(writes).toBe(1);
    expect(target.listenerCount("drain")).toBe(0);
    expect(target.destroyed).toBe(true);
    expect(harness.wss.clients.size).toBe(0);
  } finally {
    harness.controller.abort();
    await running;
  }
});
describe("node stream close acknowledgement", () => {
  it("finishes when the gateway never completes the close handshake", async () => {
    const logCapture = createDiagnosticLogRecordCapture();
    logCaptures.push(logCapture);
    const gotFrame = createDeferred();
    const gateway = rawGateway(() => gotFrame.resolve());
    const harness = await streamHarness(gateway);
    let targetPeer: net.Socket | undefined;
    const targetServer = net.createServer((peer) => {
      targetPeer = peer;
    });
    const targetPort = await listenServer(targetServer);
    let ack: (() => void) | undefined;
    const ackArmed = createDeferred();
    const realSetTimeout = globalThis.setTimeout;
    const timerSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delayMs, ...args) => {
        const timer = realSetTimeout(callback, delayMs, ...args);
        if (delayMs === 5_000) {
          ack = () => {
            clearTimeout(timer);
            callback(...args);
          };
          ackArmed.resolve();
        }
        return timer;
      });
    const running = harness.run({
      attachPath: `/node-desktop/attach?ticket=${ticket}`,
      target: { port: targetPort },
    });
    const settled = running.catch(() => undefined);
    try {
      await gotFrame.promise;
      targetPeer?.end();
      await ackArmed.promise;
      ack?.();
      await running;
      await expect
        .poll(async () => {
          await logCapture.flush();
          return logCapture.records.find((record) => record.message === STREAM_CLOSED)?.attributes;
        })
        .toMatchObject({
          streamKind: "desktop",
          trigger: "target-close",
          closeCode: 1006,
        });
    } finally {
      harness.controller.abort();
      await settled;
      targetPeer?.destroy();
      await close(targetServer);
      await harness.cleanup();
      timerSpy.mockRestore();
    }
  });

  it.each([1024, 200 * 1024])(
    "waits out a %i-byte forward instead of the short close acknowledgement",
    async (size) => {
      const payload = Buffer.alloc(size, 7);
      let receivedSevens = 0;
      const received = createDeferred();
      const harness = await websocketHarness((ws) => {
        ws.on("message", (data, isBinary) => {
          if (!isBinary) {
            return;
          }
          receivedSevens += rawDataToString(data, "latin1").split("\x07").length - 1;
          if (receivedSevens >= payload.length) {
            received.resolve();
          }
        });
      });
      const connected = createDeferred<net.Socket>();
      const targetServer = net.createServer((peer) => {
        connected.resolve(peer);
      });
      const targetPort = await listenServer(targetServer);
      const running = harness.run({ target: { port: targetPort } });
      let targetPeer: net.Socket | undefined;
      try {
        targetPeer = await connected.promise;
        targetPeer.write(payload);
        targetPeer.end();
        await received.promise;
        for (const client of harness.wss.clients) {
          client.close();
        }
        await running;
        expect(receivedSevens).toBe(payload.length);
      } finally {
        harness.controller.abort();
        await running;
        targetPeer?.destroy();
        await close(targetServer);
        await harness.cleanup();
      }
    },
  );

  it("rejects non-binary gateway data and closes the stream", async () => {
    const gatewayClosed = createDeferred();
    await using harness = await websocketHarness((ws) => {
      ws.once("message", () => ws.send("not-binary"));
      ws.once("close", () => gatewayClosed.resolve());
    });
    await expect(harness.run()).rejects.toThrow(/non-binary/);
    await gatewayClosed.promise;
    expect(harness.target.destroyed).toBe(true);
    expect(harness.wss.clients.size).toBe(0);
  });

  it("rejects a protocol error without a node handshake timer", async () => {
    await using harness = await rawFrameHarness([0x83, 0x00]);
    const started = Date.now();
    await expect(harness.run()).rejects.toThrow(/invalid opcode 3/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("closes the client when a gateway close withholds TCP FIN", async () => {
    const receivedFin = createDeferred();
    const harness = await rawFrameHarness([0x88, 0x02, 0x03, 0xe8], (socket) => {
      socket.once("end", () => receivedFin.resolve());
    });
    const closeSpy = vi.spyOn(WebSocket.prototype, "close");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = harness.run();
    const settled = running.catch(() => undefined);
    try {
      await receivedFin.promise;
      expect(harness.target.readableEnded).toBe(false);
      const client = closeSpy.mock.contexts[0];
      if (!(client instanceof WebSocket)) {
        throw new Error("Expected a client WebSocket close handshake");
      }
      const closed = once(client, "close");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.readyState).toBe(WebSocket.CLOSED);
      await closed;
      await running;
    } finally {
      harness.controller.abort();
      harness.target.destroy();
      harness.destroyPeer();
      await settled;
      closeSpy.mockRestore();
      vi.useRealTimers();
      await harness.cleanup();
    }
  });
});
