import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { afterEach, assert, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "../../packages/gateway-client/src/websocket.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  GatewayControlUiIngressRequestV1,
  GatewayControlUiIngressWebSocketRequestV1,
} from "../plugins/gateway-ingress.types.js";
import { markGatewayIngressTransport, readGatewayIngressTransport } from "./ingress-attribution.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createRemoteControlUiTransport } from "./remote-control-ui-transport.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import type { RemoteControlUiIngressContext } from "./server/client-identity-types.js";
import { startWebSocketKeepalive } from "./websocket-keepalive.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function websocketFixture(accept: (ws: WebSocket, req: IncomingMessage) => void) {
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return fixture({
    handleUpgrade: async (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => accept(ws, req));
    },
  });
}

function write(res: ServerResponse, bytes: Uint8Array) {
  return new Promise<void>((resolve, reject) => {
    res.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

function fixture(overrides: Partial<GatewayControlUiIngressHost> = {}) {
  let current = true;
  function revoke() {
    current = false;
  }
  const context = createRemoteControlUiIngressTestContext({
    assertCurrent() {
      if (!current) {
        throw new Error("Grant revoked");
      }
    },
  });
  const host: GatewayControlUiIngressHost = {
    signal: new AbortController().signal,
    controlUiBasePath: "/claw",
    getRuntimeConfig: () => ({}),
    getResolvedAuth: () => ({ mode: "token", token: "synthetic", allowTailscale: false }),
    handleRequest: async (_req, res) => void res.end("control-ui"),
    handleSandboxRequest: async (_req, res) => void res.end("sandbox-only"),
    handleUpgrade: async (_req, socket) => void socket.destroy(),
    ...overrides,
  };
  const transport = createRemoteControlUiTransport({ context, host });
  cleanups.push(() => transport.close());
  return {
    close: transport.close,
    revoke,
    request: (input: Partial<GatewayControlUiIngressRequestV1> = {}) =>
      transport.request({
        surface: "control-ui",
        method: "GET",
        pathAndQuery: "/claw/",
        headers: [["host", "ui.example.test"]],
        signal: new AbortController().signal,
        ...input,
      }),
    open: (input: Partial<GatewayControlUiIngressWebSocketRequestV1> = {}) =>
      transport.openWebSocket({
        pathAndQuery: "/claw",
        origin: "https://ui.example.test",
        protocols: [],
        signal: new AbortController().signal,
        ...input,
      }),
  };
}

it("revalidates grant authority when a caller pulls already-buffered response bytes", async () => {
  const { request, revoke } = fixture();
  const result = await request();
  revoke();
  await expect(result.response.text()).rejects.toThrow("Grant revoked");
  await result.closed;
});

it("delivers an early HTTP rejection without waiting for the upload to finish", async () => {
  const cancelled = createDeferred();
  const { request } = fixture({
    handleRequest: async (_req, res) => {
      res.writeHead(403);
      res.end("denied");
    },
  });
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(Uint8Array.of(1)),
    cancel: () => cancelled.resolve(),
  });
  const { response } = await request({ method: "POST", body });
  expect([response.status, await response.text()]).toEqual([403, "denied"]);
  await cancelled.promise;
});

it("uses real WebSocket text/binary framing and fences stale message sends", async () => {
  const { open, close, revoke } = websocketFixture((ws, req) => {
    expect(readGatewayIngressTransport(req)?.kind).toBe("remote-forwarded");
    expect(() => markGatewayIngressTransport(req, { kind: "ordinary" })).toThrow(
      "already assigned",
    );
    expect(req.headers.origin).toBe("https://ui.example.test");
    ws.on("message", (bytes, isBinary) => ws.send(bytes, { binary: isBinary }));
  });
  const { socket } = await open();
  const reader = socket.messages[Symbol.asyncIterator]();
  await expect(
    socket.send({ kind: "binary", bytes: new Uint8Array(25 * 1024 * 1024 + 1) }),
  ).rejects.toThrow("exceeds 25 MiB");
  await socket.send({ kind: "text", text: "hello" });
  expect(await reader.next()).toMatchObject({ value: { kind: "text", text: "hello" } });
  await socket.send({ kind: "binary", bytes: Uint8Array.from([0, 1, 255]) });
  const binary = await reader.next();
  assert(binary.value?.kind === "binary");
  expect(Array.from(binary.value.bytes)).toEqual([0, 1, 255]);
  revoke();
  await expect(socket.send({ kind: "text", text: "blocked" })).rejects.toThrow("Grant revoked");
  await close();
  await socket.closed;
});

it("gives upgraded sockets net.Socket timeouts so Gateway keepalive can arm them", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  try {
    const accepted = createDeferred<IncomingMessage["socket"]>();
    const { open } = websocketFixture((ws, req) => {
      startWebSocketKeepalive(ws, vi.fn(), req.socket);
      accepted.resolve(req.socket);
    });
    await open();
    const upgraded = await accepted.promise;
    expect(() => vi.advanceTimersByTime(25_000)).not.toThrow();
    expect(upgraded.timeout).toBe(25_000);
    const timedOut = vi.fn();
    upgraded.setTimeout(1_000, timedOut);
    vi.advanceTimersByTime(1_000);
    expect(timedOut).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps accepted WebSocket authority with the grant when the browser transport disconnects", async () => {
  const admitted = createDeferred<RemoteControlUiIngressContext>();
  const { open, revoke } = websocketFixture((_ws, req) => {
    const provenance = readGatewayIngressTransport(req);
    assert(provenance?.kind === "remote-forwarded", "Missing remote provenance");
    admitted.resolve(provenance.context);
  });
  const browser = new AbortController();
  const { socket } = await open({ signal: browser.signal });
  const authority = await admitted.promise;
  browser.abort(new Error("Browser disconnected"));
  await socket.closed;
  expect(authority.signal.aborted).toBe(false);
  expect(() => authority.assertCurrent()).not.toThrow();
  revoke();
  expect(() => authority.assertCurrent()).toThrow("Grant revoked");
});

it("delivers the final buffered response chunk before normal transport completion", async () => {
  const { request } = fixture({
    handleRequest: async (_req, res) => {
      await write(res, new Uint8Array(128 * 1024).fill(1));
      res.end(new Uint8Array(128 * 1024).fill(2));
    },
  });
  const result = await request();
  const bytes = new Uint8Array(await result.response.arrayBuffer());
  expect([bytes.byteLength, bytes[0], bytes[bytes.byteLength - 1]]).toEqual([256 * 1024, 1, 2]);
  await result.closed;
});

it.each(["request", "response"] as const)(
  "bounds cumulative HTTP %s bytes across small streaming chunks",
  async (direction) => {
    const chunk = new Uint8Array(1024 * 1024);
    const { request, close } = fixture({
      handleRequest: async (req, res) => {
        if (direction === "request") {
          const complete = once(req, "end");
          req.resume();
          await complete;
        } else {
          for (let index = 0; index < 101; index += 1) {
            await write(res, chunk);
          }
        }
        res.end();
      },
    });
    const body =
      direction === "request"
        ? NodeReadableStream.from(Array.from({ length: 101 }, () => chunk))
        : undefined;
    const exchange = async () => {
      const result = await request({ method: body ? "POST" : "GET", body });
      await result.response.body?.pipeTo(new WritableStream());
      await result.closed;
    };
    await expect(exchange()).rejects.toThrow(`HTTP ${direction} exceeds 100 MiB`);
    await close();
  },
);
