import fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  startGatewayServer,
  testState,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const ORIGINAL_GATEWAY_AUTH = testState.gatewayAuth;
const SECRET_REF_TOKEN_ID = "OPENCLAW_SHARED_TOKEN_HOT_RELOAD_SECRET_REF";
const OLD_TOKEN = "shared-token-hot-reload-old";
const NEW_TOKEN = "shared-token-hot-reload-new";

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port = 0;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bumpReloadDebounce(config: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(config);
  const gateway = { ...toRecord(next.gateway) };
  const reload = { ...toRecord(gateway.reload) };
  const debounceMsRaw = reload.debounceMs;
  const debounceMsCurrent =
    typeof debounceMsRaw === "number" && Number.isFinite(debounceMsRaw) ? debounceMsRaw : 0;
  reload.debounceMs = debounceMsCurrent + 1;
  gateway.reload = reload;
  next.gateway = gateway;
  return next;
}

async function openAuthenticatedWs(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, { token });
  return ws;
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function loadCurrentConfig(ws: WebSocket): Promise<Record<string, unknown>> {
  const current = await rpcReq<{
    config?: Record<string, unknown>;
  }>(ws, "config.get", {});
  expect(current.ok).toBe(true);
  return structuredClone(current.payload?.config ?? {});
}

beforeAll(async () => {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  port = await getFreePort();
  testState.gatewayAuth = undefined;
  process.env[SECRET_REF_TOKEN_ID] = OLD_TOKEN;
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: SECRET_REF_TOKEN_ID },
          },
          reload: {
            mode: "hybrid",
            debounceMs: 0,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  server = await startGatewayServer(port, { controlUiEnabled: true });
});

beforeEach(() => {
  process.env[SECRET_REF_TOKEN_ID] = OLD_TOKEN;
});

afterAll(async () => {
  delete process.env[SECRET_REF_TOKEN_ID];
  testState.gatewayAuth = ORIGINAL_GATEWAY_AUTH;
  await server.close();
});

describe("gateway shared token hot reload rotation", () => {
  it("disconnects existing shared-token websocket sessions after hot reload picks up a rotated SecretRef value", async () => {
    const ws = await openAuthenticatedWs(OLD_TOKEN);
    try {
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
      }
      const currentConfig = await loadCurrentConfig(ws);
      const nextConfig = bumpReloadDebounce(currentConfig);

      process.env[SECRET_REF_TOKEN_ID] = NEW_TOKEN;
      const closed = waitForClose(ws);
      await fs.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");

      await expect(closed).resolves.toMatchObject({
        code: 4001,
        reason: "gateway auth changed",
      });
    } finally {
      ws.close();
    }
  });
});
