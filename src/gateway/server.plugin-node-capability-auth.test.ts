import fs from "node:fs/promises";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import os from "node:os";
import { join as joinPath } from "node:path";
import type { Duplex } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withTimeout } from "../utils/with-timeout.js";
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
const CANVAS_CAPABILITY_PATH_PREFIX = PLUGIN_NODE_CAPABILITY_PATH_PREFIX;

type CanvasHostHandler = {
  rootDir: string;
  basePath: string;
  handleHttpRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => Promise<void>;
};

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

async function listen(
  server: ReturnType<typeof createGatewayHttpServer>,
  host = "127.0.0.1",
): Promise<{
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, host, resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    host,
    port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
        SERVER_CLOSE_TIMEOUT_MS,
        { message: "gateway test server close timed out" },
      );
    },
  };
}

async function expectWsRejected(
  url: string,
  headers: Record<string, string>,
  expectedStatus = 401,
): Promise<void> {
  const target = new URL(url);
  const response = await requestWsUpgradeResponse({
    port: Number(target.port),
    path: `${target.pathname}${target.search}`,
    headers,
  });
  expect(response.statusCode).toBe(expectedStatus);
  expect(response.complete).toBe(true);
}

async function requestWsUpgradeResponse(params: {
  port: number;
  path: string;
  headers: Record<string, string>;
}): Promise<{
  statusCode: number;
  headers: IncomingMessage["headers"];
  body: string;
  complete: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: params.port,
      path: params.path,
      headers: {
        ...params.headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    req.setTimeout(WS_REJECT_TIMEOUT_MS, () => {
      req.destroy(new Error("timeout"));
    });
    req.once("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          complete: res.complete,
        });
      });
    });
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("expected upgrade to reject"));
    });
    req.once("error", reject);
    req.end();
  });
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

function canvasUrl(listener: CanvasGatewayListener, path = CANVAS_HOST_PATH): string {
  return `http://127.0.0.1:${listener.port}${path}`;
}

async function fetchCanvasHost(
  listener: CanvasGatewayListener,
  init?: RequestInit,
): Promise<Response> {
  return await fetchCanvas(canvasUrl(listener), init);
}

async function expectMalformedRequestTargetsRejected(params: {
  listener: CanvasGatewayListener;
  headers?: readonly string[];
}): Promise<void> {
  for (const requestTarget of ["//", "///", "//${jndi:ldap://example}.action"]) {
    const response = await sendRawHttpRequest({
      host: "127.0.0.1",
      port: params.listener.port,
      requestTarget,
      ...(params.headers ? { headers: params.headers } : {}),
    });
    expect(response).toMatch(/^HTTP\/1\.1 401 /);
  }

  const res = await fetchCanvasHost(params.listener);
  expect(res.status).toBe(401);
}

async function expectRepeatedCanvasAuthAttemptsRateLimited(
  listener: CanvasGatewayListener,
  headers: Record<string, string>,
): Promise<Response> {
  const first = await fetchCanvasHost(listener, { headers });
  expect(first.status).toBe(401);

  const second = await fetchCanvasHost(listener, { headers });
  expect(second.status).toBe(429);
  return second;
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

function scopedCanvasPath(capability: string, path: string): string {
  return `${CANVAS_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(capability)}${path}`;
}

const allowCanvasHostHttp: CanvasHostHandler["handleHttpRequest"] = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== CANVAS_HOST_PATH && !url.pathname.startsWith(`${CANVAS_HOST_PATH}/`)) {
    return false;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("ok");
  return true;
};
async function withCanvasGatewayHarness(params: {
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  listenHost?: string;
  rateLimiter?: ReturnType<typeof createGatewayAuthRateLimiter>;
  handleHttpRequest: CanvasHostHandler["handleHttpRequest"];
  resolvePluginNodeCapabilityRoute?: Parameters<
    typeof attachGatewayUpgradeHandler
  >[0]["resolvePluginNodeCapabilityRoute"];
  desktopSessionRegistry?: Parameters<
    typeof attachGatewayUpgradeHandler
  >[0]["desktopSessionRegistry"];
  run: (ctx: {
    listener: Awaited<ReturnType<typeof listen>>;
    clients: Set<GatewayWsClient>;
  }) => Promise<void>;
}) {
  const clients = new Set<GatewayWsClient>();
  const canvasWss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PREAUTH_PAYLOAD_BYTES,
  });
  const canvasHandler: CanvasHostHandler = {
    rootDir: "test",
    basePath: "/canvas",
    close: async () => {},
    handleUpgrade: (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== CANVAS_WS_PATH) {
        return false;
      }
      canvasWss.handleUpgrade(req, socket, head, (ws) => {
        // Let the client observe a successful open before the harness closes.
        setImmediate(() => ws.close());
      });
      return true;
    },
    handleHttpRequest: params.handleHttpRequest,
  };

  const httpServer = createGatewayHttpServer({
    clients,
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
      return canvasHandler.handleHttpRequest(req, res);
    },
    resolvePluginNodeCapabilityRoute:
      params.resolvePluginNodeCapabilityRoute ?? (() => ({ surface: "canvas" })),
    resolvedAuth: params.resolvedAuth,
    getResolvedAuth: params.getResolvedAuth,
    rateLimiter: params.rateLimiter,
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PREAUTH_PAYLOAD_BYTES,
  });
  attachGatewayUpgradeHandler({
    httpServer,
    wss,
    handlePluginUpgrade: async (req, socket, head) =>
      canvasHandler.handleUpgrade(req, socket, head),
    resolvePluginNodeCapabilityRoute:
      params.resolvePluginNodeCapabilityRoute ?? (() => ({ surface: "canvas" })),
    clients,
    preauthConnectionBudget: createPreauthConnectionBudget(8),
    resolvedAuth: params.resolvedAuth,
    getResolvedAuth: params.getResolvedAuth,
    rateLimiter: params.rateLimiter,
    desktopSessionRegistry: params.desktopSessionRegistry,
  });

  const listener = await listen(httpServer, params.listenHost);
  try {
    await params.run({ listener, clients });
  } finally {
    for (const ws of canvasWss.clients) {
      ws.terminate();
    }
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await withTimeout(
      new Promise<void>((resolve) => {
        canvasWss.close(() => resolve());
      }),
      SERVER_CLOSE_TIMEOUT_MS,
      { message: "canvas websocket server close timed out" },
    );
    await withTimeout(
      new Promise<void>((resolve) => {
        wss.close(() => resolve());
      }),
      SERVER_CLOSE_TIMEOUT_MS,
      { message: "gateway websocket server close timed out" },
    );
    await listener.close();
    params.rateLimiter?.dispose();
  }
}

describe("gateway plugin node capability auth", () => {
  const tokenResolvedAuth: ResolvedGatewayAuth = {
    mode: "token",
    token: "test-token",
    password: undefined,
    allowTailscale: false,
  };

  const withLoopbackTrustedProxy = async (run: () => Promise<void>, prefix?: string) => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      },
      ...(prefix ? { prefix } : {}),
      run,
    });
  };

  test("authorizes canvas HTTP/WS via node-scoped capability and rejects misuse", async () => {
    await withLoopbackTrustedProxy(async () => {
      await withCanvasGatewayHarness({
        resolvedAuth: tokenResolvedAuth,
        handleHttpRequest: allowCanvasHostHttp,
        run: async ({ listener, clients }) => {
          const host = "127.0.0.1";
          const webchatCapability = "webchat-cap";
          const expiredNodeCapability = "expired-node";
          const activeNodeCapability = "active-node";
          const activeCanvasPath = scopedCanvasPath(activeNodeCapability, `${CANVAS_HOST_PATH}/`);
          const activeWsPath = scopedCanvasPath(activeNodeCapability, CANVAS_WS_PATH);

          const unauthCanvas = await fetchCanvas(
            `http://${host}:${listener.port}${CANVAS_HOST_PATH}/`,
          );
          expect(unauthCanvas.status).toBe(401);

          const malformedScoped = await fetchCanvas(
            `http://${host}:${listener.port}${CANVAS_CAPABILITY_PATH_PREFIX}/broken`,
          );
          expect(malformedScoped.status).toBe(401);

          clients.add(makeWsClient(webchatCapability, { role: "operator", mode: "webchat" }));

          const webchatCapabilityAllowed = await fetchCanvas(
            `http://${host}:${listener.port}${scopedCanvasPath(webchatCapability, `${CANVAS_HOST_PATH}/`)}`,
          );
          expect(webchatCapabilityAllowed.status).toBe(200);

          clients.add(makeWsClient(expiredNodeCapability, { expiresAtMs: Date.now() - 1 }));

          const expiredCapabilityBlocked = await fetchCanvas(
            `http://${host}:${listener.port}${scopedCanvasPath(expiredNodeCapability, `${CANVAS_HOST_PATH}/`)}`,
          );
          expect(expiredCapabilityBlocked.status).toBe(401);

          const activeNodeClient = makeWsClient(activeNodeCapability);
          clients.add(activeNodeClient);

          const scopedCanvas = await fetchCanvas(
            `http://${host}:${listener.port}${activeCanvasPath}`,
          );
          expect(scopedCanvas.status).toBe(200);
          expect(await scopedCanvas.text()).toBe("ok");

          const scopedA2ui = await fetchCanvas(
            `http://${host}:${listener.port}${scopedCanvasPath(activeNodeCapability, `${A2UI_PATH}/`)}`,
          );
          expect([200, 404, 503]).toContain(scopedA2ui.status);

          await expectWsConnected(`ws://${host}:${listener.port}${activeWsPath}`);

          clients.delete(activeNodeClient);

          const disconnectedNodeBlocked = await fetchCanvas(
            `http://${host}:${listener.port}${activeCanvasPath}`,
          );
          expect(disconnectedNodeBlocked.status).toBe(401);
          await expectWsRejected(`ws://${host}:${listener.port}${activeWsPath}`, {});
        },
      });
    }, "openclaw-canvas-auth-test-");
  }, 60_000);

  test("does not charge a stale bearer when a valid node capability succeeds", async () => {
    await withLoopbackTrustedProxy(async () => {
      const rateLimiter = createGatewayAuthRateLimiter(
        {
          maxAttempts: 1,
          windowMs: 60_000,
          lockoutMs: 60_000,
          pruneIntervalMs: 0,
        },
        { scheduler: createTestGatewayScheduler() },
      );
      await withCanvasGatewayHarness({
        resolvedAuth: tokenResolvedAuth,
        rateLimiter,
        handleHttpRequest: allowCanvasHostHttp,
        run: async ({ listener, clients }) => {
          const capability = "active-node";
          clients.add(makeWsClient(capability));
          const proxyHeaders = {
            authorization: "Bearer stale-token",
            "x-forwarded-for": "203.0.113.99",
          };

          const scopedCanvas = await fetchCanvas(
            `http://127.0.0.1:${listener.port}${scopedCanvasPath(capability, `${CANVAS_HOST_PATH}/`)}`,
            { headers: proxyHeaders },
          );
          expect(scopedCanvas.status).toBe(200);
          await expectWsConnected(
            `ws://127.0.0.1:${listener.port}${scopedCanvasPath(capability, CANVAS_WS_PATH)}`,
            proxyHeaders,
          );

          const sharedSecretControl = await fetchCanvas(
            `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
            {
              headers: {
                authorization: "Bearer test-token",
                "x-forwarded-for": "203.0.113.99",
              },
            },
          );
          expect(sharedSecretControl.status).toBe(200);
        },
      });
    });
  }, 60_000);

  test("revalidates a node capability after awaited bearer auth", async () => {
    const capability = "active-node";
    const rateLimiter = createGatewayAuthRateLimiter(
      {
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
        pruneIntervalMs: 0,
      },
      { scheduler: createTestGatewayScheduler() },
    );
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
    await withCanvasGatewayHarness({
      resolvedAuth: tokenResolvedAuth,
      handleHttpRequest: allowCanvasHostHttp,
      run: async ({ listener, clients }) => {
        const capability = "active-node";
        clients.add(makeWsClient(capability));

        const response = await fetchCanvas(
          `http://127.0.0.1:${listener.port}${scopedCanvasPath(capability, `${CANVAS_HOST_PATH}/`)}`,
          {
            headers: {
              authorization: "Bearer stale-token",
              "x-forwarded-for": "203.0.113.99",
            },
          },
        );

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error: { type: "proxy_attribution_required" },
        });
      },
    });
  }, 60_000);

  test("rejects malformed raw HTTP request targets without disrupting gateway", async () => {
    await withCanvasGatewayHarness({
      resolvedAuth: tokenResolvedAuth,
      handleHttpRequest: allowCanvasHostHttp,
      run: async ({ listener }) => {
        await expectMalformedRequestTargetsRejected({ listener });
      },
    });
  }, 60_000);

  test("rejects malformed raw WebSocket upgrade targets without disrupting gateway", async () => {
    await withCanvasGatewayHarness({
      resolvedAuth: tokenResolvedAuth,
      handleHttpRequest: allowCanvasHostHttp,
      run: async ({ listener }) => {
        await expectMalformedRequestTargetsRejected({
          listener,
          headers: [
            "Host: localhost",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
          ],
        });
      },
    });
  }, 60_000);

  test("re-resolves canvas bearer auth on each upgrade after shared auth rotation", async () => {
    let currentAuth = tokenResolvedAuth;

    await withCanvasGatewayHarness({
      resolvedAuth: tokenResolvedAuth,
      getResolvedAuth: () => currentAuth,
      handleHttpRequest: allowCanvasHostHttp,
      run: async ({ listener }) => {
        const url = `ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`;

        await expectWsConnected(url, {
          authorization: "Bearer test-token",
        });

        currentAuth = {
          ...tokenResolvedAuth,
          token: "rotated-token",
        };

        await expectWsRejected(url, {
          authorization: "Bearer test-token",
        });
        await expectWsConnected(url, {
          authorization: "Bearer rotated-token",
        });
      },
    });
  }, 60_000);

  test("returns 429 for repeated failed canvas auth attempts (HTTP + WS upgrade)", async () => {
    await withLoopbackTrustedProxy(async () => {
      const rateLimiter = createGatewayAuthRateLimiter(
        {
          maxAttempts: 1,
          windowMs: 60_000,
          lockoutMs: 60_000,
          exemptLoopback: false,
        },
        { scheduler: createTestGatewayScheduler() },
      );
      await withCanvasGatewayHarness({
        resolvedAuth: tokenResolvedAuth,
        rateLimiter,
        handleHttpRequest: async () => false,
        run: async ({ listener }) => {
          const headers = {
            authorization: "Bearer wrong",
            "x-forwarded-for": "203.0.113.99",
          };
          const second = await expectRepeatedCanvasAuthAttemptsRateLimited(listener, headers);
          expect(second.headers.get("retry-after")).toMatch(/^\d+$/);

          const upgradeResponse = await requestWsUpgradeResponse({
            port: listener.port,
            path: CANVAS_WS_PATH,
            headers,
          });
          const expectedBody = JSON.stringify({
            error: {
              message: "Too many failed authentication attempts. Please try again later.",
              type: "rate_limited",
            },
          });
          expect(upgradeResponse.statusCode).toBe(429);
          expect(upgradeResponse.headers["retry-after"]).toMatch(/^\d+$/);
          expect(upgradeResponse.headers["content-length"]).toBe(
            String(Buffer.byteLength(expectedBody, "utf8")),
          );
          expect(upgradeResponse.body).toBe(expectedBody);
          expect(upgradeResponse.complete).toBe(true);
        },
      });
    });
  }, 60_000);

  test("rejects spoofed loopback forwarding headers from trusted proxies", async () => {
    await withLoopbackTrustedProxy(async () => {
      const rateLimiter = createGatewayAuthRateLimiter(
        {
          maxAttempts: 1,
          windowMs: 60_000,
          lockoutMs: 60_000,
          exemptLoopback: true,
        },
        { scheduler: createTestGatewayScheduler() },
      );
      await withCanvasGatewayHarness({
        resolvedAuth: tokenResolvedAuth,
        listenHost: "0.0.0.0",
        rateLimiter,
        handleHttpRequest: async () => false,
        run: async ({ listener }) => {
          await expectRepeatedCanvasAuthAttemptsRateLimited(listener, {
            authorization: "Bearer wrong",
            host: "localhost",
            "x-forwarded-for": "127.0.0.1, 203.0.113.24",
          });
        },
      });
    });
  }, 60_000);

  test("routes one-shot worker desktop tokens through the real gateway upgrade path", async () => {
    const root = await fs.mkdtemp(joinPath(await fs.realpath(os.tmpdir()), "ocwd-"));
    const localSocketPath = joinPath(root, "desktop.sock");
    const rfbBytes = Buffer.from("RFB 003.008\n");
    const desktopSockets = new Set<Socket>();
    const desktopServer = createServer((socket) => {
      desktopSockets.add(socket);
      socket.once("close", () => desktopSockets.delete(socket));
      socket.write(rfbBytes);
    });
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        desktopServer.once("error", reject);
        desktopServer.listen(localSocketPath, () => {
          desktopServer.off("error", reject);
          resolve();
        });
      }),
      5_000,
      { message: "desktop unix server listen timed out" },
    );
    const release = vi.fn();
    const desktopSessionRegistry = {
      attachObserver: () => ({ release }),
    } as unknown as NonNullable<
      Parameters<typeof attachGatewayUpgradeHandler>[0]["desktopSessionRegistry"]
    >;
    try {
      await withCanvasGatewayHarness({
        resolvedAuth: tokenResolvedAuth,
        handleHttpRequest: async () => false,
        resolvePluginNodeCapabilityRoute: () => undefined,
        desktopSessionRegistry,
        run: async ({ listener }) => {
          const minted = mintDesktopObserverToken({
            sourceKey: "worker:boundary",
            ownerEpoch: 4,
            control: false,
            attachment: { kind: "unix-socket", socketPath: localSocketPath },
          });
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
          const draining = mintDesktopObserverToken({
            sourceKey: "worker:boundary",
            ownerEpoch: 4,
            control: false,
            attachment: { kind: "unix-socket", socketPath: localSocketPath },
          });
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
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      for (const socket of desktopSockets) {
        socket.destroy();
      }
      await withTimeout(
        new Promise<void>((resolve) => {
          desktopServer.close(() => resolve());
        }),
        5_000,
        { message: "desktop unix server close timed out" },
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
