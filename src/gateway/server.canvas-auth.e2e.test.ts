import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "../canvas-host/a2ui.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { withTempConfig } from "./test-temp-config.js";

async function listen(server: ReturnType<typeof createGatewayHttpServer>): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
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

async function withCanvasGatewayHarness(params: {
  resolvedAuth: ResolvedGatewayAuth;
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

  const listener = await listen(httpServer);
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
  test("allows canvas IP fallback for private/CGNAT addresses and denies public fallback", async () => {
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
            const privateIpA = "192.168.1.10";
            const privateIpB = "192.168.1.11";
            const publicIp = "203.0.113.10";
            const cgnatIp = "100.100.100.100";

            const unauthCanvas = await fetch(
              `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
              {
                headers: { "x-forwarded-for": privateIpA },
              },
            );
            expect(unauthCanvas.status).toBe(401);

            const unauthA2ui = await fetch(`http://127.0.0.1:${listener.port}${A2UI_PATH}/`, {
              headers: { "x-forwarded-for": privateIpA },
            });
            expect(unauthA2ui.status).toBe(401);

            await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {
              "x-forwarded-for": privateIpA,
            });

            clients.add({
              socket: {} as unknown as WebSocket,
              connect: {} as never,
              connId: "c1",
              clientIp: privateIpA,
            });

            const authCanvas = await fetch(
              `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
              {
                headers: { "x-forwarded-for": privateIpA },
              },
            );
            expect(authCanvas.status).toBe(200);
            expect(await authCanvas.text()).toBe("ok");

            const otherIpStillBlocked = await fetch(
              `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
              {
                headers: { "x-forwarded-for": privateIpB },
              },
            );
            expect(otherIpStillBlocked.status).toBe(401);

            clients.add({
              socket: {} as unknown as WebSocket,
              connect: {} as never,
              connId: "c-public",
              clientIp: publicIp,
            });
            const publicIpStillBlocked = await fetch(
              `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
              {
                headers: { "x-forwarded-for": publicIp },
              },
            );
            expect(publicIpStillBlocked.status).toBe(401);
            await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {
              "x-forwarded-for": publicIp,
            });

            clients.add({
              socket: {} as unknown as WebSocket,
              connect: {} as never,
              connId: "c-cgnat",
              clientIp: cgnatIp,
            });
            const cgnatAllowed = await fetch(
              `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
              {
                headers: { "x-forwarded-for": cgnatIp },
              },
            );
            expect(cgnatAllowed.status).toBe(200);

            await new Promise<void>((resolve, reject) => {
              const ws = new WebSocket(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {
                headers: { "x-forwarded-for": privateIpA },
              });
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
