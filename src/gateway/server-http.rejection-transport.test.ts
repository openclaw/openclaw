import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { text } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import { createWebSocketStream, WebSocketServer, type WebSocket } from "ws";
import { readWebhookBodyOrReject } from "../plugin-sdk/webhook-request-guards.js";
import { createDeferredCore } from "../shared/deferred.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
import { createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));

const resolvedAuth = { mode: "none" as const, allowTailscale: false };
type ServerOptions = Parameters<typeof createGatewayHttpServer>[0];
type UpgradeOptions = Partial<Parameters<typeof attachGatewayUpgradeHandler>[0]>;
async function startServer(
  overrides: Pick<ServerOptions, "handleHooksRequest"> & Partial<ServerOptions>,
) {
  const clients = new Set<never>();
  const server = createGatewayHttpServer({
    clients,
    controlUiEnabled: false,
    controlUiBasePath: "",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    resolvedAuth,
    getRuntimeConfig: () => ({}),
    ...overrides,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "missing listener");
  const port = address.port;
  const cleanup: (() => void)[] = [];
  const webservers: WebSocketServer[] = [];
  const tasks: Promise<unknown>[] = [];
  return {
    server,
    port,
    tasks,
    cleanup: (dispose: () => void) => cleanup.push(dispose),
    connect() {
      const socket = connect({ host: "127.0.0.1", port });
      cleanup.push(() => socket.destroy());
      return socket;
    },
    capture() {
      const capture = captureSocket(port);
      cleanup.push(() => capture.socket.destroy());
      return capture;
    },
    upgrade(upgradeOptions: UpgradeOptions = {}) {
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
      attachGatewayUpgradeHandler({
        httpServer: server,
        wss,
        clients,
        resolvedAuth,
        preauthConnectionBudget: createPreauthConnectionBudget(),
        ...upgradeOptions,
      });
      webservers.push(wss);
      return wss;
    },
    async [Symbol.asyncDispose]() {
      cleanup.forEach((dispose) => dispose());
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      webservers.forEach((wss) => wss.close());
      await Promise.all(tasks);
    },
  };
}

const upgradeRequest =
  "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n";
const websocketRequest = `${upgradeRequest}Sec-WebSocket-Key: dGVzdC1rZXktMDEyMzQ1Ng==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
const textFrame = Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x79]);
const reply =
  (body: string, status = 200) =>
  async (_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = status;
    res.end(body);
    return true;
  };
function captureSocket(port: number) {
  const socket = connect({ host: "127.0.0.1", port });
  const deadline = setTimeout(() => socket.destroy(new Error("client deadline")), 3000);
  // Consuming to EOF proves graceful delivery; resets and the deadline reject the read.
  const response = text(socket).finally(() => clearTimeout(deadline));
  return { socket, response };
}

it("rejects websocket upgrade headers that Node routes as ordinary HTTP", async () => {
  const handleHooksRequest = vi.fn(reply("", 204));
  await using fixture = await startServer({
    controlUiBasePath: "/__control__",
    handleHooksRequest,
    getRuntimeConfig: () => ({ gateway: { trustedProxies: [] } }),
  });
  const { socket, response } = fixture.capture();
  const closed = once(socket, "close", { signal: AbortSignal.timeout(1_000) });
  socket.write(
    `GET /hooks/wake HTTP/1.1\r\nHost: 127.0.0.1:${fixture.port}\r\nUpgrade: websocket\r\nConnection: keep-alive\r\n\r\n`,
  );
  const [, wire] = await Promise.all([closed, response]);
  expect(wire).toContain("HTTP/1.1 400 Bad Request");
  expect(wire).toContain("Connection: close");
  expect(handleHooksRequest).not.toHaveBeenCalled();
});

it("flushes HTTP 503 before closing when a WebSocket upgrade throws", async () => {
  await using fixture = await startServer({ handleHooksRequest: async () => false });
  const wss = fixture.upgrade();
  const connected = vi.fn();
  wss.on("connection", connected);
  wss.once("headers", () => {
    throw new Error("upgrade failed");
  });
  const capture = fixture.capture();
  capture.socket.write(websocketRequest);
  const wire = await capture.response;
  expect(connected).not.toHaveBeenCalled();
  expect(wire).toBe("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
});

it("delivers an upgrade rejection after an ordinary response on a reused connection", async () => {
  await using fixture = await startServer({ handleHooksRequest: reply("ready") });
  fixture.upgrade();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  fixture.cleanup(() => agent.destroy());
  const readResponse = async (upgrade: boolean) => {
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      request(
        {
          host: "127.0.0.1",
          port: fixture.port,
          path: "/socket",
          agent,
          headers: upgrade ? { connection: "Upgrade", upgrade: "websocket" } : {},
        },
        resolve,
      )
        .once("error", reject)
        .end();
    });
    return { status: res.statusCode, body: await text(res) };
  };
  await expect(readResponse(false)).resolves.toEqual({ status: 200, body: "ready" });
  await expect(readResponse(true)).resolves.toEqual({
    status: 503,
    body: "Gateway websocket handlers unavailable",
  });
});

it("contains browser socket errors while plugin upgrade routing is pending", async () => {
  const routing = createDeferredCore<Duplex>();
  const releaseRouting = createDeferredCore();
  const routed = createDeferredCore();
  await using fixture = await startServer({ handleHooksRequest: reply("still available") });
  fixture.upgrade({
    shouldEnforcePluginGatewayAuth: () => false,
    handlePluginUpgrade: async (_req, socket) => {
      routing.resolve(socket);
      await releaseRouting.promise;
      routed.resolve();
      return true;
    },
  });
  const browser = fixture.connect();
  let transport: Duplex | undefined = undefined;
  fixture.cleanup(() => {
    releaseRouting.resolve();
    transport?.destroy();
  });
  await once(browser, "connect");
  browser.write(`${upgradeRequest}\r\n`);
  transport = await routing.promise;
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  expect(() => transport!.emit("error", reset)).not.toThrow();
  expect(transport.destroyed).toBe(true);
  releaseRouting.resolve();
  await routed.promise;
  expect(await (await fetch(`http://127.0.0.1:${fixture.port}/next`)).text()).toBe(
    "still available",
  );
});

it.each(["Gateway", "plugin", "plugin stream"])(
  "preserves %s WebSocket pause after a queued upgrade",
  async (route) => {
    let earlier: ServerResponse | undefined;
    let upgradeSeen = false;
    let transport: Duplex | undefined;
    let websocket: WebSocket | undefined;
    let stream: Duplex | undefined;
    const buffered = createDeferredCore();
    await using fixture = await startServer({
      handleHooksRequest: async (_req, res) => {
        earlier = res;
        if (upgradeSeen) {
          res.end("earlier");
        }
        return true;
      },
    });
    const accept = (ws: WebSocket) => {
      websocket = ws;
      if (route === "plugin stream") {
        stream = createWebSocketStream(ws, { highWaterMark: 1 });
        stream.once("readable", () => {
          ws.send("ready");
          buffered.resolve();
        });
      } else {
        ws.pause();
        ws.send("ready");
      }
    };
    const wss: WebSocketServer = fixture.upgrade({
      handlePluginUpgrade: route.startsWith("plugin")
        ? async (req, socket, head) => {
            wss.handleUpgrade(req, socket, head, accept);
            if (route === "plugin stream") {
              await buffered.promise;
            }
            return true;
          }
        : undefined,
      shouldEnforcePluginGatewayAuth: () => false,
    });
    wss.on("connection", accept);
    fixture.server.once("upgrade", (_req, socket) => {
      transport = socket;
      upgradeSeen = true;
      earlier?.end("earlier");
    });
    const socket = fixture.connect();
    const ready = createDeferredCore();
    let wire = "";
    socket.on("data", (chunk) => {
      wire += chunk.toString();
      if (wire.endsWith("ready")) {
        ready.resolve();
      }
    });
    socket.on("error", ready.reject);
    const deadline = setTimeout(() => ready.reject(new Error("client deadline")), 3000);
    fixture.cleanup(() => {
      clearTimeout(deadline);
      stream?.destroy();
      websocket?.terminate();
      transport?.destroy();
    });
    socket.write(`GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n${websocketRequest}`);
    if (route === "plugin stream") {
      socket.write(textFrame);
    }
    await ready.promise;
    expect(wire.match(/HTTP\/1\.1 \d{3}/g)).toEqual(["HTTP/1.1 200", "HTTP/1.1 101"]);
    expect([websocket!.isPaused, transport!.isPaused()]).toEqual([true, true]);
    if (stream) {
      expect(stream.read().toString()).toBe("x");
    }
    const message = once(websocket!, "message");
    socket.write(textFrame);
    websocket!.resume();
    expect((await message)[0].toString()).toBe("x");
  },
);

it.each([
  { version: "1.0", expectation: "100-continue", status: 200, interim: false },
  { version: "1.1", expectation: "100-Continue", status: 200, interim: true },
  { version: "1.1", expectation: "unsupported", status: 417, interim: false },
])(
  "preserves Node Expect admission for HTTP/$version $expectation",
  async ({ version, expectation, status, interim }) => {
    const dispatched: string[] = [];
    await using fixture = await startServer({
      handleHooksRequest: async (req, res) => {
        dispatched.push(req.url!);
        res.end("accepted");
        return true;
      },
    });
    const { socket, response } = fixture.capture();
    socket.write(
      `GET /expect HTTP/${version}\r\nHost: localhost\r\nExpect: ${expectation}\r\nConnection: close\r\n\r\n`,
    );
    const wire = await response;
    expect(wire.match(/HTTP\/1\.1 \d{3}/g)).toEqual(
      interim ? ["HTTP/1.1 100", `HTTP/1.1 ${status}`] : [`HTTP/1.1 ${status}`],
    );
    expect(dispatched).toEqual(status === 200 ? ["/expect"] : []);
    expect(wire.endsWith(status === 200 ? "accepted" : "\r\n\r\n")).toBe(true);
  },
);

it.each([
  ["ordinary", ""],
  ["upgrade", "Connection: Upgrade\r\nUpgrade: websocket\r\n"],
  ["continue", "Expect: 100-continue\r\nContent-Length: 1\r\n"],
  ["expectation", "Expect: unsupported\r\n"],
  ["connect", ""],
])("does not route a pipelined %s request after a rejected upload", async (next, headers) => {
  const dispatched: string[] = [];
  const upgrades = vi.fn(async () => true);
  await using fixture: Awaited<ReturnType<typeof startServer>> = await startServer({
    handleHooksRequest: async (req, res) => {
      dispatched.push(req.url!);
      const task = readWebhookBodyOrReject({ req, res, maxBytes: 256 * 1024 });
      fixture.tasks.push(task);
      await task;
      return true;
    },
  });
  fixture.upgrade({
    handlePluginUpgrade: upgrades,
    shouldEnforcePluginGatewayAuth: () => false,
  });
  const { socket, response } = fixture.capture();
  const payload = "x".repeat(1024 * 1024 + 1);
  const requestLine = next === "connect" ? "CONNECT localhost:80 HTTP/1.1" : "GET /second HTTP/1.1";
  socket.write(
    `POST /first HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n${payload.length.toString(16)}\r\n${payload}\r\n0\r\n\r\n${requestLine}\r\nHost: localhost\r\n${headers}\r\n`,
  );
  const wire = await response;
  expect(wire).toMatch(/^HTTP\/1\.1 413 /);
  expect(wire).toContain("X-Content-Type-Options: nosniff");
  expect(wire.split("\r\n\r\n")[1]).toBe("Payload too large");
  expect(dispatched).toEqual(["/first"]);
  expect(upgrades).not.toHaveBeenCalled();
});
