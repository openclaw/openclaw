import fs from "node:fs/promises";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, createServer, type ListenOptions, type Socket } from "node:net";
import os from "node:os";
import { join as joinPath } from "node:path";
import { text as readText } from "node:stream/consumers";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { withTimeout } from "../infra/fs-safe.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayAuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { DESKTOP_OBSERVE_PATH, mintDesktopObserverToken } from "./desktop/observe-bridge.js";
import { PLUGIN_NODE_CAPABILITY_PATH_PREFIX } from "./plugin-node-capability.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
import { createGatewayHttpServer } from "./server-http.js";
import { authorizePluginNodeCapabilityRequest } from "./server/plugin-node-capability-auth.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { withTempConfig } from "./test-temp-config.js";

const WS_REJECT_TIMEOUT_MS = 2_000;
const WS_CONNECT_TIMEOUT_MS = 5_000;
const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const SERVER_CLOSE_TIMEOUT_MS = 5_000;
const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_WS_PATH = "/__openclaw__/test/ws";

afterEach(() => clearRuntimeConfigSnapshot());

const tokenResolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  password: undefined,
  allowTailscale: false,
};

function authRateLimiter(options: { exemptLoopback?: boolean; pruneIntervalMs?: number } = {}) {
  return createGatewayAuthRateLimiter(
    { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, ...options },
    { scheduler: createTestGatewayScheduler() },
  );
}

async function expectCanvasStatus(
  listener: CanvasGatewayListener,
  path: string,
  status: number,
  headers?: Record<string, string>,
) {
  const response = await fetchCanvas(canvasUrl(listener, path), { headers });
  expect(response.status).toBe(status);
  return response;
}

type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
type UpgradeOptions = Parameters<typeof attachGatewayUpgradeHandler>[0];

async function fetchCanvas(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("connection", "close");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function closeServer(
  server: { close(callback: (err?: Error) => void): unknown },
  name: string,
  ignoreError = false,
) {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err && !ignoreError ? reject(err) : resolve()));
    }),
    SERVER_CLOSE_TIMEOUT_MS,
    { message: `${name} server close timed out` },
  );
}

async function listen(
  server: ReturnType<typeof createServer>,
  address: ListenOptions = { host: "127.0.0.1", port: 0 },
) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await (address.path
    ? withTimeout(listening, SERVER_CLOSE_TIMEOUT_MS, {
        message: "desktop server listen timed out",
      })
    : listening);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server, "gateway test", Boolean(address.path));
    },
  };
}

async function expectWsRejected(
  url: string,
  headers: Record<string, string>,
  expectedStatus = 401,
): Promise<void> {
  expect(await requestWsUpgradeResponse(url, headers)).toMatchObject({
    statusCode: expectedStatus,
    complete: true,
  });
}

async function requestWsUpgradeResponse(url: string, headers: Record<string, string>) {
  const target = new URL(url);
  const req = request({
    host: "127.0.0.1",
    port: Number(target.port),
    path: `${target.pathname}${target.search}`,
    headers: {
      ...headers,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  });
  req.setTimeout(WS_REJECT_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.once("response", resolve);
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("expected upgrade to reject"));
    });
    req.once("error", reject);
  });
  req.end();
  const res = await response;
  const body = await readText(res);
  return { statusCode: res.statusCode ?? 0, headers: res.headers, body, complete: res.complete };
}

async function expectWsConnected(url: string, headers?: Record<string, string>): Promise<void> {
  const ws = new WebSocket(url, { headers });
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
        ws.once("unexpected-response", (_req, res) =>
          reject(new Error(`unexpected response ${res.statusCode}`)),
        );
        ws.once("close", () => reject(new Error("socket closed before open")));
      }),
      WS_CONNECT_TIMEOUT_MS,
      { message: "websocket connect timed out" },
    );
  } finally {
    ws.terminate();
  }
}

async function sendRawHttpRequest(params: {
  host: string;
  port: number;
  requestTarget: string;
  headers?: readonly string[];
}): Promise<string> {
  const socket = connect({ host: params.host, port: params.port }, () => {
    const headers = params.headers ?? ["Host: localhost", "Connection: close"];
    socket.write([`GET ${params.requestTarget} HTTP/1.1`, ...headers, "", ""].join("\r\n"));
  });
  try {
    return await withTimeout(
      new Promise<string>((resolve, reject) => {
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          response += chunk.toString();
        });
        socket.once("close", () => resolve(response));
        socket.once("error", reject);
      }),
      WS_REJECT_TIMEOUT_MS,
      { message: "raw HTTP request timed out" },
    );
  } finally {
    socket.destroy();
  }
}

type CanvasGatewayListener = Awaited<ReturnType<typeof listen>>;

function canvasUrl(
  listener: CanvasGatewayListener,
  path = CANVAS_HOST_PATH,
  protocol = "http",
): string {
  return `${protocol}://127.0.0.1:${listener.port}${path}`;
}

async function expectRepeatedCanvasAuthAttemptsRateLimited(
  listener: CanvasGatewayListener,
  headers: Record<string, string>,
): Promise<Response> {
  await expectCanvasStatus(listener, CANVAS_HOST_PATH, 401, headers);
  return await expectCanvasStatus(listener, CANVAS_HOST_PATH, 429, headers);
}

function makeWsClient(
  capability: string,
  params: { role?: "node" | "operator"; mode?: "node" | "webchat"; expiresAtMs?: number } = {},
): GatewayWsClient {
  return {
    socket: {} as unknown as WebSocket,
    connect: {
      role: params.role ?? "node",
      client: { mode: params.mode ?? "node" },
    } as GatewayWsClient["connect"],
    connId: capability,
    usesSharedGatewayAuth: false,
    clientIp: "203.0.113.99",
    pluginNodeCapabilities: {
      canvas: { capability, expiresAtMs: params.expiresAtMs ?? Date.now() + 60_000 },
    },
  };
}

function scopedCanvasPath(capability: string, path = `${CANVAS_HOST_PATH}/`): string {
  return `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(capability)}${path}`;
}

const allowCanvasHostHttp: HttpHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== CANVAS_HOST_PATH && !url.pathname.startsWith(`${CANVAS_HOST_PATH}/`)) {
    return false;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("ok");
  return true;
};
async function withCanvasGatewayHarness(
  run: (ctx: { listener: CanvasGatewayListener; clients: Set<GatewayWsClient> }) => Promise<void>,
  params: {
    getResolvedAuth?: () => ResolvedGatewayAuth;
    listenHost?: string;
    rateLimiter?: ReturnType<typeof createGatewayAuthRateLimiter>;
    handleHttpRequest?: HttpHandler;
    resolvePluginNodeCapabilityRoute?: UpgradeOptions["resolvePluginNodeCapabilityRoute"];
    desktopSessionRegistry?: UpgradeOptions["desktopSessionRegistry"];
  } = {},
) {
  const clients = new Set<GatewayWsClient>();
  const canvasWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
  const shared = {
    clients,
    resolvedAuth: tokenResolvedAuth,
    getResolvedAuth: params.getResolvedAuth,
    rateLimiter: params.rateLimiter,
    resolvePluginNodeCapabilityRoute:
      params.resolvePluginNodeCapabilityRoute ?? (() => ({ surface: "canvas" as const })),
  };
  const httpServer = createGatewayHttpServer({
    ...shared,
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    handlePluginRequest: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === A2UI_PATH || url.pathname.startsWith(`${A2UI_PATH}/`)) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("A2UI assets not found");
        return true;
      }
      return (params.handleHttpRequest ?? allowCanvasHostHttp)(req, res);
    },
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
  attachGatewayUpgradeHandler({
    httpServer,
    wss,
    handlePluginUpgrade: async (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== CANVAS_WS_PATH) {
        return false;
      }
      canvasWss.handleUpgrade(req, socket, head, (ws) => {
        // Let the client observe a successful open before the harness closes.
        setImmediate(() => ws.close());
      });
      return true;
    },
    ...shared,
    preauthConnectionBudget: createPreauthConnectionBudget(8),
    desktopSessionRegistry: params.desktopSessionRegistry,
  });

  const listener = await listen(httpServer, { host: params.listenHost ?? "127.0.0.1", port: 0 });
  try {
    await run({ listener, clients });
  } finally {
    const servers = [
      ["canvas", canvasWss],
      ["gateway", wss],
    ] as const;
    for (const [, server] of servers) {
      for (const ws of server.clients) {
        ws.terminate();
      }
    }
    for (const [name, server] of servers) {
      await closeServer(server, `${name} websocket`, true);
    }
    await listener.close();
    params.rateLimiter?.dispose();
  }
}

describe("gateway plugin node capability auth", () => {
  const withLoopbackTrustedProxy = (
    run: Parameters<typeof withCanvasGatewayHarness>[0],
    params?: Parameters<typeof withCanvasGatewayHarness>[1],
  ) =>
    withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      run: () => withCanvasGatewayHarness(run, params),
    });

  test("authorizes canvas HTTP/WS via node-scoped capability and rejects misuse", async () => {
    await withLoopbackTrustedProxy(async ({ listener, clients }) => {
      const activeNodeCapability = "active-node";
      const activeCanvasPath = scopedCanvasPath(activeNodeCapability);
      const activeWsPath = scopedCanvasPath(activeNodeCapability, CANVAS_WS_PATH);
      await expectCanvasStatus(listener, `${CANVAS_HOST_PATH}/`, 401);
      await expectCanvasStatus(listener, `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/broken`, 401);
      for (const [capability, options, status] of [
        ["webchat-cap", { role: "operator", mode: "webchat" }, 200],
        ["expired-node", { expiresAtMs: Date.now() - 1 }, 401],
      ] as const) {
        clients.add(makeWsClient(capability, options));
        await expectCanvasStatus(listener, scopedCanvasPath(capability), status);
      }
      const activeNodeClient = makeWsClient(activeNodeCapability);
      clients.add(activeNodeClient);
      const scopedCanvas = await expectCanvasStatus(listener, activeCanvasPath, 200);
      expect(await scopedCanvas.text()).toBe("ok");
      const scopedA2ui = await fetchCanvas(
        canvasUrl(listener, scopedCanvasPath(activeNodeCapability, `${A2UI_PATH}/`)),
      );
      expect([200, 404, 503]).toContain(scopedA2ui.status);
      await expectWsConnected(canvasUrl(listener, activeWsPath, "ws"));
      clients.delete(activeNodeClient);
      await expectCanvasStatus(listener, activeCanvasPath, 401);
      await expectWsRejected(canvasUrl(listener, activeWsPath, "ws"), {});
    });
  }, 60_000);

  test("does not charge a stale bearer when a valid node capability succeeds", async () => {
    const rateLimiter = authRateLimiter({ pruneIntervalMs: 0 });
    await withLoopbackTrustedProxy(
      async ({ listener, clients }) => {
        const capability = "active-node";
        clients.add(makeWsClient(capability));
        const proxyHeaders = {
          authorization: "Bearer stale-token",
          "x-forwarded-for": "203.0.113.99",
        };
        await expectCanvasStatus(listener, scopedCanvasPath(capability), 200, proxyHeaders);
        await expectWsConnected(
          `ws://127.0.0.1:${listener.port}${scopedCanvasPath(capability, CANVAS_WS_PATH)}`,
          proxyHeaders,
        );
        await expectCanvasStatus(listener, `${CANVAS_HOST_PATH}/`, 200, {
          authorization: "Bearer test-token",
          "x-forwarded-for": "203.0.113.99",
        });
      },
      { rateLimiter },
    );
  }, 60_000);

  test("revalidates a node capability after awaited bearer auth", async () => {
    setRuntimeConfigSnapshot({});
    const capability = "active-node";
    const rateLimiter = authRateLimiter({ exemptLoopback: false, pruneIntervalMs: 0 });
    const client = makeWsClient(capability);
    const result = authorizePluginNodeCapabilityRequest({
      req: {
        headers: { authorization: "Bearer stale-token" },
        socket: { remoteAddress: "127.0.0.1" },
      } as IncomingMessage,
      auth: tokenResolvedAuth,
      trustedProxies: [],
      allowRealIpFallback: false,
      clients: new Set([client]),
      nodeCapability: { surface: "canvas" },
      capability,
      rateLimiter,
    });
    try {
      client.invalidated = true;
      await expect(result).resolves.toMatchObject({ ok: false, reason: "token_mismatch" });
      expect(rateLimiter.check("127.0.0.1", "shared-secret").allowed).toBe(false);
    } finally {
      rateLimiter.dispose();
    }
  });

  test("does not let node capability fallback bypass missing proxy attribution", async () => {
    setRuntimeConfigSnapshot({});
    await withCanvasGatewayHarness(async ({ listener, clients }) => {
      const capability = "active-node";
      clients.add(makeWsClient(capability));
      const response = await expectCanvasStatus(listener, scopedCanvasPath(capability), 403, {
        authorization: "Bearer stale-token",
        "x-forwarded-for": "203.0.113.99",
      });
      await expect(response.json()).resolves.toMatchObject({
        error: { type: "proxy_attribution_required" },
      });
    });
  }, 60_000);

  test.each([
    ["HTTP", undefined],
    [
      "WebSocket",
      [
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ],
    ],
  ] as const)(
    "rejects malformed raw %s targets without disrupting gateway",
    async (_transport, headers) => {
      setRuntimeConfigSnapshot({});
      await withCanvasGatewayHarness(async ({ listener }) => {
        for (const requestTarget of ["//", "///", "//${jndi:ldap://example}.action"]) {
          const response = await sendRawHttpRequest({
            host: "127.0.0.1",
            port: listener.port,
            requestTarget,
            headers,
          });
          expect(response).toMatch(/^HTTP\/1\.1 401 /);
        }
        await expectCanvasStatus(listener, CANVAS_HOST_PATH, 401);
      });
    },
    60_000,
  );

  test("re-resolves canvas bearer auth on each upgrade after shared auth rotation", async () => {
    setRuntimeConfigSnapshot({});
    let currentAuth = tokenResolvedAuth;
    await withCanvasGatewayHarness(
      async ({ listener }) => {
        const url = `ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`;
        await expectWsConnected(url, { authorization: "Bearer test-token" });
        currentAuth = { ...tokenResolvedAuth, token: "rotated-token" };
        await expectWsRejected(url, { authorization: "Bearer test-token" });
        await expectWsConnected(url, { authorization: "Bearer rotated-token" });
      },
      { getResolvedAuth: () => currentAuth },
    );
  }, 60_000);

  test("returns 429 for repeated failed canvas auth attempts (HTTP + WS upgrade)", async () => {
    const rateLimiter = authRateLimiter({ exemptLoopback: false });
    await withLoopbackTrustedProxy(
      async ({ listener }) => {
        const headers = { authorization: "Bearer wrong", "x-forwarded-for": "203.0.113.99" };
        const second = await expectRepeatedCanvasAuthAttemptsRateLimited(listener, headers);
        expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
        const upgradeResponse = await requestWsUpgradeResponse(
          canvasUrl(listener, CANVAS_WS_PATH, "ws"),
          headers,
        );
        const expectedBody = JSON.stringify({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        });
        expect(upgradeResponse).toMatchObject({
          statusCode: 429,
          complete: true,
          body: expectedBody,
          headers: {
            "retry-after": expect.stringMatching(/^\d+$/),
            "content-length": String(Buffer.byteLength(expectedBody, "utf8")),
          },
        });
      },
      { rateLimiter, handleHttpRequest: async () => false },
    );
  }, 60_000);

  test("rejects spoofed loopback forwarding headers from trusted proxies", async () => {
    const rateLimiter = authRateLimiter({ exemptLoopback: true });
    await withLoopbackTrustedProxy(
      async ({ listener }) => {
        await expectRepeatedCanvasAuthAttemptsRateLimited(listener, {
          authorization: "Bearer wrong",
          host: "localhost",
          "x-forwarded-for": "127.0.0.1, 203.0.113.24",
        });
      },
      { listenHost: "0.0.0.0", rateLimiter, handleHttpRequest: async () => false },
    );
  }, 60_000);

  test("routes one-shot worker desktop tokens through the real gateway upgrade path", async () => {
    setRuntimeConfigSnapshot({});
    const root = await fs.mkdtemp(joinPath(await fs.realpath(os.tmpdir()), "ocwd-"));
    const localSocketPath = joinPath(root, "desktop.sock");
    const rfbBytes = Buffer.from("RFB 003.008\n");
    const desktopServer = await listen(
      createServer((socket) => socket.write(rfbBytes)),
      {
        path: localSocketPath,
      },
    );
    const release = vi.fn();
    const desktopSessionRegistry = {
      attachObserver: () => ({ release }),
    } as unknown as NonNullable<UpgradeOptions["desktopSessionRegistry"]>;
    try {
      await withCanvasGatewayHarness(
        async ({ listener }) => {
          const mintToken = () =>
            mintDesktopObserverToken({
              sourceKey: "worker:boundary",
              ownerEpoch: 4,
              control: false,
              attachment: { kind: "unix-socket", socketPath: localSocketPath },
            });
          const minted = mintToken();
          const url = `ws://127.0.0.1:${listener.port}${DESKTOP_OBSERVE_PATH}?token=${minted.token}`;
          const ws = new WebSocket(url);
          const received = new Promise<Buffer>((resolve, reject) => {
            ws.once("message", (data) => resolve(Buffer.from(data as Buffer)));
            ws.once("error", reject);
          });
          await expect(
            withTimeout(received, 5_000, { message: "desktop RFB bytes timed out" }),
          ).resolves.toEqual(rfbBytes);
          ws.terminate();
          await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
          await expectWsRejected(url, {}, 401);

          // A draining Gateway must refuse new desktop observers like every other
          // core upgrade; otherwise restart/suspension leaks long-lived sockets.
          const draining = mintToken();
          markGatewayRestartDraining();
          try {
            await expectWsRejected(
              `ws://127.0.0.1:${listener.port}${DESKTOP_OBSERVE_PATH}?token=${draining.token}`,
              {},
              503,
            );
          } finally {
            resetGatewayWorkAdmission();
          }
        },
        {
          handleHttpRequest: async () => false,
          resolvePluginNodeCapabilityRoute: () => undefined,
          desktopSessionRegistry,
        },
      );
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await desktopServer.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
