import os from "node:os";
import path from "node:path";
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
const ORIGINAL_GATEWAY_TOKEN_ENV = process.env.OPENCLAW_GATEWAY_TOKEN;
const OLD_TOKEN = "shared-token-old";
const NEW_TOKEN = "shared-token-new";
const DEFERRED_RESTART_DELAY_MS = 1_000;
const RESTARTING_AUTH_CHANGE_METHODS = ["config.patch", "config.apply"] as const;
const SECRET_REF_TOKEN_ID = "OPENCLAW_SHARED_AUTH_ROTATION_SECRET_REF";

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port = 0;

beforeAll(async () => {
  port = await getFreePort();
  testState.gatewayAuth = { mode: "token", token: OLD_TOKEN };
  server = await startGatewayServer(port, { controlUiEnabled: true });
});

afterAll(async () => {
  testState.gatewayAuth = ORIGINAL_GATEWAY_AUTH;
  if (ORIGINAL_GATEWAY_TOKEN_ENV === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = ORIGINAL_GATEWAY_TOKEN_ENV;
  }
  await server.close();
});

async function openAuthenticatedWs(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, { token });
  return ws;
}

async function openDeviceTokenWs(): Promise<WebSocket> {
  const identityPath = path.join(os.tmpdir(), `openclaw-shared-auth-${process.pid}-${port}.json`);
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
    await import("../infra/device-identity.js");
  const { approveDevicePairing, requestDevicePairing, rotateDeviceToken } =
    await import("../infra/device-pairing.js");

  const identity = loadOrCreateDeviceIdentity(identityPath);
  const pending = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    clientId: "test",
    clientMode: "test",
    role: "operator",
    scopes: ["operator.admin"],
  });
  await approveDevicePairing(pending.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  const rotated = await rotateDeviceToken({
    deviceId: identity.deviceId,
    role: "operator",
    scopes: ["operator.admin"],
  });
  expect(rotated.ok).toBe(true);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, {
    skipDefaultAuth: true,
    deviceIdentityPath: identityPath,
    deviceToken: rotated.ok ? rotated.entry.token : "",
    scopes: ["operator.admin"],
  });
  return ws;
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function loadCurrentConfig(ws: WebSocket): Promise<{
  hash: string;
  config: Record<string, unknown>;
}> {
  const current = await rpcReq<{
    hash?: string;
    config?: Record<string, unknown>;
  }>(ws, "config.get", {});
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  return {
    hash: String(current.payload?.hash),
    config: structuredClone(current.payload?.config ?? {}),
  };
}

async function sendAuthTokenChange(
  ws: WebSocket,
  method: (typeof RESTARTING_AUTH_CHANGE_METHODS)[number],
): Promise<{ ok: boolean }> {
  const current = await loadCurrentConfig(ws);
  const currentConfig = current.config;
  const gateway = (currentConfig.gateway ??= {}) as Record<string, unknown>;
  const auth = (gateway.auth ??= {}) as Record<string, unknown>;
  auth.token = NEW_TOKEN;

  if (method === "config.patch") {
    return await rpcReq(ws, "config.patch", {
      baseHash: current.hash,
      raw: JSON.stringify({ gateway: { auth: { token: NEW_TOKEN } } }),
      restartDelayMs: DEFERRED_RESTART_DELAY_MS,
    });
  }

  return await rpcReq(ws, method, {
    raw: JSON.stringify(currentConfig, null, 2),
  });
}

describe("gateway shared auth rotation", () => {
  for (const method of RESTARTING_AUTH_CHANGE_METHODS) {
    it(`disconnects existing shared-token websocket sessions after ${method}`, async () => {
      const ws = await openAuthenticatedWs(OLD_TOKEN);
      try {
        const closed = waitForClose(ws);
        const res = await sendAuthTokenChange(ws, method);

        expect(res.ok).toBe(true);
        await expect(closed).resolves.toMatchObject({
          code: 4001,
          reason: "gateway auth changed",
        });
      } finally {
        ws.close();
      }
    });
  }

  it("keeps existing device-token websocket sessions connected after shared token rotation", async () => {
    const ws = await openDeviceTokenWs();
    try {
      const res = await sendAuthTokenChange(ws, "config.patch");
      expect(res.ok).toBe(true);

      const followUp = await rpcReq<{ hash?: string }>(ws, "config.get", {});
      expect(followUp.ok).toBe(true);
      expect(typeof followUp.payload?.hash).toBe("string");
    } finally {
      ws.close();
    }
  });
});

describe("gateway shared auth rotation with unchanged SecretRefs", () => {
  let secretRefServer: Awaited<ReturnType<typeof startGatewayServer>>;
  let secretRefPort = 0;

  beforeAll(async () => {
    secretRefPort = await getFreePort();
    process.env[SECRET_REF_TOKEN_ID] = OLD_TOKEN;
    testState.gatewayAuth = {
      mode: "token",
      token: { source: "env", provider: "default", id: SECRET_REF_TOKEN_ID },
    };
    secretRefServer = await startGatewayServer(secretRefPort, { controlUiEnabled: true });
  });

  afterAll(async () => {
    delete process.env[SECRET_REF_TOKEN_ID];
    testState.gatewayAuth = ORIGINAL_GATEWAY_AUTH;
    await secretRefServer.close();
  });

  async function openSecretRefAuthenticatedWs(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${secretRefPort}`);
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await connectOk(ws, { token: OLD_TOKEN });
    return ws;
  }

  for (const method of ["config.set", "config.apply"] as const) {
    it(`keeps shared-auth websocket sessions connected when ${method} reapplies an unchanged SecretRef token`, async () => {
      const ws = await openSecretRefAuthenticatedWs();
      try {
        const current = await rpcReq<{
          hash?: string;
          config?: Record<string, unknown>;
        }>(ws, "config.get", {});
        expect(current.ok).toBe(true);
        expect(typeof current.payload?.hash).toBe("string");

        const res = await rpcReq(ws, method, {
          raw: JSON.stringify(current.payload?.config ?? {}, null, 2),
          ...(method === "config.set" ? { baseHash: current.payload?.hash } : {}),
        });
        expect(res.ok).toBe(true);

        const followUp = await rpcReq<{ hash?: string }>(ws, "config.get", {});
        expect(followUp.ok).toBe(true);
        expect(typeof followUp.payload?.hash).toBe("string");
      } finally {
        ws.close();
      }
    });
  }
});
