import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type OpenClawConfig, writeConfigFile } from "../config/config.js";
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

function buildHotReloadConfig(): OpenClawConfig {
  return {
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
  };
}

async function openAuthenticatedWs(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, { token });
  return ws;
}

async function waitForClose(
  ws: WebSocket,
  timeoutMs = 10_000,
): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

beforeAll(async () => {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  port = await getFreePort();
  testState.gatewayAuth = undefined;
  process.env[SECRET_REF_TOKEN_ID] = OLD_TOKEN;
  await writeConfigFile(buildHotReloadConfig());
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

describe("gateway shared token SecretRef reload rotation", () => {
  it("disconnects existing shared-token websocket sessions after secrets.reload picks up a rotated SecretRef value", async () => {
    const ws = await openAuthenticatedWs(OLD_TOKEN);
    try {
      process.env[SECRET_REF_TOKEN_ID] = NEW_TOKEN;
      const closed = waitForClose(ws);
      const reload = await rpcReq<{ warningCount?: number }>(ws, "secrets.reload", {}).catch(
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      );

      await expect(closed).resolves.toMatchObject({
        code: 4001,
        reason: "gateway auth changed",
      });
      if (!(reload instanceof Error)) {
        expect(reload.ok).toBe(true);
      }
    } finally {
      ws.close();
    }
  });
});
