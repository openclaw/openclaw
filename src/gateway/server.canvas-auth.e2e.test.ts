import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "../canvas-host/a2ui.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";

async function withTempConfig(params: { cfg: unknown; run: () => Promise<void> }): Promise<void> {
  const prevConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const prevDisableCache = process.env.OPENCLAW_DISABLE_CONFIG_CACHE;

  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-auth-test-"));
  const configPath = path.join(dir, "openclaw.json");

  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_DISABLE_CONFIG_CACHE = "1";

  try {
    await writeFile(configPath, JSON.stringify(params.cfg, null, 2), "utf-8");
    await params.run();
  } finally {
    if (prevConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = prevConfigPath;
    }
    if (prevDisableCache === undefined) {
      delete process.env.OPENCLAW_DISABLE_CONFIG_CACHE;
    } else {
      process.env.OPENCLAW_DISABLE_CONFIG_CACHE = prevDisableCache;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

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

describe("gateway canvas host auth", () => {
  test("authorizes canvas/a2ui HTTP and canvas WS by matching an authenticated gateway ws client ip", async () => {
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
            canvasWss.handleUpgrade(req, socket, head, (ws) => {
              ws.close();
            });
            return true;
          },
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
        };

        const httpServer = createGatewayHttpServer({
          canvasHost,
          clients,
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });

        const wss = new WebSocketServer({ noServer: true });
        attachGatewayUpgradeHandler({
          httpServer,
          wss,
          canvasHost,
          clients,
          resolvedAuth,
        });

        const listener = await listen(httpServer);
        try {
          const ipA = "203.0.113.10";
          const ipB = "203.0.113.11";

          const unauthCanvas = await fetch(
            `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
            {
              headers: { "x-forwarded-for": ipA },
            },
          );
          expect(unauthCanvas.status).toBe(401);

          const unauthA2ui = await fetch(`http://127.0.0.1:${listener.port}${A2UI_PATH}/`, {
            headers: { "x-forwarded-for": ipA },
          });
          expect(unauthA2ui.status).toBe(401);

          await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {
            "x-forwarded-for": ipA,
          });

          clients.add({
            socket: {} as unknown as WebSocket,
            connect: {} as never,
            connId: "c1",
            clientIp: ipA,
          });

          const authCanvas = await fetch(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`, {
            headers: { "x-forwarded-for": ipA },
          });
          expect(authCanvas.status).toBe(200);
          expect(await authCanvas.text()).toBe("ok");

          const otherIpStillBlocked = await fetch(
            `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
            {
              headers: { "x-forwarded-for": ipB },
            },
          );
          expect(otherIpStillBlocked.status).toBe(401);

          await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {
              headers: { "x-forwarded-for": ipA },
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
        } finally {
          await listener.close();
          canvasWss.close();
          wss.close();
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
        const clients = new Set<GatewayWsClient>();
        const rateLimiter = createAuthRateLimiter({
          maxAttempts: 1,
          windowMs: 60_000,
          lockoutMs: 60_000,
        });
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
          handleHttpRequest: async (_req, _res) => false,
        };

        const httpServer = createGatewayHttpServer({
          canvasHost,
          clients,
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          rateLimiter,
        });

        const wss = new WebSocketServer({ noServer: true });
        attachGatewayUpgradeHandler({
          httpServer,
          wss,
          canvasHost,
          clients,
          resolvedAuth,
          rateLimiter,
        });

        const listener = await listen(httpServer);
        try {
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

          await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, headers, 429);
        } finally {
          await listener.close();
          rateLimiter.dispose();
          canvasWss.close();
          wss.close();
        }
      },
    });
  }, 60_000);
});
