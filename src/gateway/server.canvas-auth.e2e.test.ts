import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { CANVAS_CAPABILITY_PATH_PREFIX } from "./canvas-capability.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { withTempConfig } from "./test-temp-config.js";

async function listen(
  server: ReturnType<typeof createGatewayHttpServer>,
  host = "127.0.0.1",
): Promise<{
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    host,
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

async function expectWsRejected(
  url: string,
  headers: Record<string, string>,
  expectedStatus = 401,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error("expected ws to reject"));
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      expect(res.statusCode).toBe(expectedStatus);
      resolve();
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function makeWsClient(params: {
  connId: string;
  clientIp: string;
  role: "node" | "operator";
  mode: "node" | "backend";
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
}): GatewayWsClient {
  return {
    socket: {} as unknown as WebSocket,
    connect: {
      role: params.role,
      client: {
        mode: params.mode,
      },
    } as GatewayWsClient["connect"],
    connId: params.connId,
    clientIp: params.clientIp,
    canvasCapability: params.canvasCapability,
    canvasCapabilityExpiresAtMs: params.canvasCapabilityExpiresAtMs,
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
  listenHost?: string;
  rateLimiter?: ReturnType<typeof createAuthRateLimiter>;
  handleHttpRequest: CanvasHostHandler["handleHttpRequest"];
  run: (ctx: {
    listener: Awaited<ReturnType<typeof listen>>;
    clients: Set<GatewayWsClient>;
  }) => Promise<void>;
}) {
  const clients = new Set<GatewayWsClient>();
  const canvasWss = new WebSocketServer({ noServer: true });
  const canvasHost: CanvasHostHandler = {
    rootDir: "test",
    basePath: "/canvas",
    close: async () => {},
    handleUpgrade: (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== CANVAS_WS_PATH) {
        return false;
      }
      canvasWss.handleUpgrade(req, socket, head, (ws) => ws.close());
      return true;
    },
    handleHttpRequest: params.handleHttpRequest,
  };

  const httpServer = createGatewayHttpServer({
    canvasHost,
    clients,
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: params.resolvedAuth,
    rateLimiter: params.rateLimiter,
  });

  const wss = new WebSocketServer({ noServer: true });
  attachGatewayUpgradeHandler({
    httpServer,
    wss,
    canvasHost,
    clients,
    resolvedAuth: params.resolvedAuth,
    rateLimiter: params.rateLimiter,
  });

  const listener = await listen(httpServer, params.listenHost);
  try {
    await params.run({ listener, clients });
  } finally {
    await listener.close();
    params.rateLimiter?.dispose();
    canvasWss.close();
    wss.close();
  }
}

describe("gateway canvas host auth", () => {
  test("authorizes canvas HTTP/WS via node-scoped capability and rejects misuse", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      },
      prefix: "openclaw-canvas-auth-test-",
      run: async () => {
        await withCanvasGatewayHarness({
          resolvedAuth,
          handleHttpRequest: allowCanvasHostHttp,
          run: async ({ listener, clients }) => {
            const host = "127.0.0.1";
            const operatorOnlyCapability = "operator-only";
            const expiredNodeCapability = "expired-node";
            const activeNodeCapability = "active-node";
            const activeCanvasPath = scopedCanvasPath(activeNodeCapability, `${CANVAS_HOST_PATH}/`);
            const activeWsPath = scopedCanvasPath(activeNodeCapability, CANVAS_WS_PATH);

            const unauthCanvas = await fetch(`http://${host}:${listener.port}${CANVAS_HOST_PATH}/`);
            expect(unauthCanvas.status).toBe(401);

            const malformedScoped = await fetch(
              `http://${host}:${listener.port}${CANVAS_CAPABILITY_PATH_PREFIX}/broken`,
            );
            expect(malformedScoped.status).toBe(401);

            clients.add(
              makeWsClient({
                connId: "c-operator",
                clientIp: "192.168.1.10",
                role: "operator",
                mode: "backend",
                canvasCapability: operatorOnlyCapability,
                canvasCapabilityExpiresAtMs: Date.now() + 60_000,
              }),
            );

            const operatorCapabilityBlocked = await fetch(
              `http://${host}:${listener.port}${scopedCanvasPath(operatorOnlyCapability, `${CANVAS_HOST_PATH}/`)}`,
            );
            expect(operatorCapabilityBlocked.status).toBe(401);

            clients.add(
              makeWsClient({
                connId: "c-expired-node",
                clientIp: "192.168.1.20",
                role: "node",
                mode: "node",
                canvasCapability: expiredNodeCapability,
                canvasCapabilityExpiresAtMs: Date.now() - 1,
              }),
            );

            const expiredCapabilityBlocked = await fetch(
              `http://${host}:${listener.port}${scopedCanvasPath(expiredNodeCapability, `${CANVAS_HOST_PATH}/`)}`,
            );
            expect(expiredCapabilityBlocked.status).toBe(401);

            const activeNodeClient = makeWsClient({
              connId: "c-active-node",
              clientIp: "192.168.1.30",
              role: "node",
              mode: "node",
              canvasCapability: activeNodeCapability,
              canvasCapabilityExpiresAtMs: Date.now() + 60_000,
            });
            clients.add(activeNodeClient);

            const scopedCanvas = await fetch(`http://${host}:${listener.port}${activeCanvasPath}`);
            expect(scopedCanvas.status).toBe(200);
            expect(await scopedCanvas.text()).toBe("ok");

            const scopedA2ui = await fetch(
              `http://${host}:${listener.port}${scopedCanvasPath(activeNodeCapability, `${A2UI_PATH}/`)}`,
            );
            expect(scopedA2ui.status).toBe(200);

            await new Promise<void>((resolve, reject) => {
              const ws = new WebSocket(`ws://${host}:${listener.port}${activeWsPath}`);
              const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
              ws.once("open", () => {
                clearTimeout(timer);
                ws.terminate();
                resolve();
              });
              ws.once("unexpected-response", (_req, res) => {
                clearTimeout(timer);
                reject(new Error(`unexpected response ${res.statusCode}`));
              });
              ws.once("error", reject);
            });

            clients.delete(activeNodeClient);

            const disconnectedNodeBlocked = await fetch(
              `http://${host}:${listener.port}${activeCanvasPath}`,
            );
            expect(disconnectedNodeBlocked.status).toBe(401);
            await expectWsRejected(`ws://${host}:${listener.port}${activeWsPath}`, {});
          },
        });
      },
    });
  }, 60_000);

  test("denies canvas auth when trusted proxy omits forwarded client headers", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      },
      run: async () => {
        await withCanvasGatewayHarness({
          resolvedAuth,
          handleHttpRequest: allowCanvasHostHttp,
          run: async ({ listener, clients }) => {
            clients.add(
              makeWsClient({
                connId: "c-loopback-node",
                clientIp: "127.0.0.1",
                role: "node",
                mode: "node",
                canvasCapability: "unused",
                canvasCapabilityExpiresAtMs: Date.now() + 60_000,
              }),
            );

            const res = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`);
            expect(res.status).toBe(401);

            await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {});
          },
        });
      },
    });
  }, 60_000);

  test("accepts capability-scoped paths over IPv6 loopback", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["::1"],
        },
      },
      run: async () => {
        try {
          await withCanvasGatewayHarness({
            resolvedAuth,
            listenHost: "::1",
            handleHttpRequest: async (req, res) => {
              const url = new URL(req.url ?? "/", "http://localhost");
              if (
                url.pathname !== CANVAS_HOST_PATH &&
                !url.pathname.startsWith(`${CANVAS_HOST_PATH}/`)
              ) {
                return false;
              }
              res.statusCode = 200;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end("ok");
              return true;
            },
            run: async ({ listener, clients }) => {
              const capability = "ipv6-node";
              clients.add(
                makeWsClient({
                  connId: "c-ipv6-node",
                  clientIp: "fd12:3456:789a::2",
                  role: "node",
                  mode: "node",
                  canvasCapability: capability,
                  canvasCapabilityExpiresAtMs: Date.now() + 60_000,
                }),
              );

              const canvasPath = scopedCanvasPath(capability, `${CANVAS_HOST_PATH}/`);
              const wsPath = scopedCanvasPath(capability, CANVAS_WS_PATH);
              const scopedCanvas = await fetch(`http://[::1]:${listener.port}${canvasPath}`);
              expect(scopedCanvas.status).toBe(200);

              await new Promise<void>((resolve, reject) => {
                const ws = new WebSocket(`ws://[::1]:${listener.port}${wsPath}`);
                const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
                ws.once("open", () => {
                  clearTimeout(timer);
                  ws.terminate();
                  resolve();
                });
                ws.once("unexpected-response", (_req, res) => {
                  clearTimeout(timer);
                  reject(new Error(`unexpected response ${res.statusCode}`));
                });
                ws.once("error", reject);
              });
            },
          });
        } catch (err) {
          const message = String(err);
          if (message.includes("EAFNOSUPPORT") || message.includes("EADDRNOTAVAIL")) {
            return;
          }
          throw err;
        }
      },
    });
  }, 60_000);

  test("returns 429 for repeated failed canvas auth attempts (HTTP + WS upgrade)", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      },
      run: async () => {
        const rateLimiter = createAuthRateLimiter({
          maxAttempts: 1,
          windowMs: 60_000,
          lockoutMs: 60_000,
          exemptLoopback: false,
        });
        await withCanvasGatewayHarness({
          resolvedAuth,
          rateLimiter,
          handleHttpRequest: async () => false,
          run: async ({ listener }) => {
            const headers = {
              authorization: "Bearer wrong",
              "x-forwarded-for": "203.0.113.99",
            };
            const first = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`, {
              headers,
            });
            expect(first.status).toBe(401);

            const second = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`, {
              headers,
            });
            expect(second.status).toBe(429);
            expect(second.headers.get("retry-after")).toBeTruthy();

            await expectWsRejected(
              `ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`,
              headers,
              429,
            );
          },
        });
      },
    });
  }, 60_000);
});
