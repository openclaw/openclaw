import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const OLD_TOKEN = "shared-token-old";
const NEW_TOKEN = "shared-token-new";

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port = 0;

beforeAll(async () => {
  port = await getFreePort();
  testState.gatewayAuth = { mode: "token", token: OLD_TOKEN };
  server = await startGatewayServer(port, { controlUiEnabled: true });
});

afterAll(async () => {
  testState.gatewayAuth = ORIGINAL_GATEWAY_AUTH;
  await server.close();
});

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

describe("gateway shared auth rotation", () => {
  it("disconnects existing shared-token websocket sessions after config rotation", async () => {
    const ws = await openAuthenticatedWs(OLD_TOKEN);
    try {
      const current = await rpcReq<{ hash?: string }>(ws, "config.get", {});
      expect(current.ok).toBe(true);
      expect(typeof current.payload?.hash).toBe("string");

      const closed = waitForClose(ws);
      const res = await rpcReq<{ restart?: { scheduled?: boolean } }>(ws, "config.patch", {
        baseHash: current.payload?.hash,
        raw: JSON.stringify({
          gateway: {
            auth: {
              token: NEW_TOKEN,
            },
          },
        }),
        restartDelayMs: 60_000,
      });

      expect(res.ok).toBe(true);
      await expect(closed).resolves.toMatchObject({
        code: 4001,
        reason: "gateway auth changed",
      });
    } finally {
      ws.close();
    }
  });
});
