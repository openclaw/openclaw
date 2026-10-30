// Shared auth suite helpers provide WebSocket clients, signed device payloads,
// pairing utilities, and gateway harness setup for auth-mode tests.
import path from "node:path";
import { expect } from "vitest";
import { WebSocket } from "ws";
import { buildDeviceAuthPayload } from "../../packages/gateway-client/src/device-auth.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayAuthConfig, GatewayConfig } from "../config/types.gateway.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayTailscaleIngressEndpoint } from "./ingress-attribution.js";
import {
  connectReq,
  getTrackedConnectChallengeNonce,
  onceMessage,
  startServerWithClient,
  trackConnectChallengeNonce,
  testState,
} from "./test-helpers.js";

let authIdentityPathSeq = 0;

export const BROWSER_ORIGIN = "https://control.example.com";
export const TRUSTED_BROWSER_HEADERS = {
  origin: BROWSER_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "admin@example.com",
};

export function browserProxyAuth(overrides: Partial<GatewayAuthConfig> = {}): GatewayAuthConfig {
  return {
    mode: "trusted-proxy",
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
    ...overrides,
  };
}

export async function configureBrowserAuth(
  auth = browserProxyAuth(),
  options: Pick<GatewayConfig, "roles" | "tailscale"> = {},
) {
  const { writeConfigFile } = await import("../config/config.js");
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      ...options,
      trustedProxies: ["127.0.0.1"],
      controlUi: testState.gatewayControlUi,
    },
  });
}

function nextAuthIdentityPath(prefix: string): string {
  const poolId = process.env.VITEST_POOL_ID ?? "0";
  const fileName =
    prefix + "-" + String(process.pid) + "-" + poolId + "-" + String(authIdentityPathSeq++);
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR must be set by the gateway test hooks");
  }
  return path.join(stateDir, "test-device-identities", fileName, "client", "credentials.sqlite");
}

export async function waitForWsClose(ws: WebSocket, timeoutMs: number): Promise<boolean> {
  if (ws.readyState === WebSocket.CLOSED) {
    return true;
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(ws.readyState === WebSocket.CLOSED), timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function openAuthWs(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => {
    ws.once("open", resolve);
  });
  return ws;
}

export const openWs = (port: number, headers?: Record<string, string>) =>
  openAuthWs(`ws://127.0.0.1:${port}`, headers);

export const readConnectChallengeNonce = async (ws: WebSocket) => {
  const cached = getTrackedConnectChallengeNonce(ws);
  if (cached) {
    return cached;
  }
  const challenge = await onceMessage(
    ws,
    (o) => o.type === "event" && o.event === "connect.challenge",
  );
  const nonce = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
  expect(typeof nonce).toBe("string");
  return String(nonce);
};

export const openTailscaleWs = (
  endpoint: GatewayTailscaleIngressEndpoint,
  headers?: Record<string, string>,
) =>
  openAuthWs(`ws://${endpoint.host}:${endpoint.port}`, {
    "x-forwarded-for": "100.64.0.1",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "gateway.tailnet.ts.net",
    "tailscale-user-login": "peter",
    "tailscale-user-name": "Peter",
    ...headers,
  });

export const originForPort = (port: number) => `http://127.0.0.1:${port}`;

export function restoreGatewayToken(prevToken: string | undefined) {
  if (prevToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
  }
}

function authClient<Id extends string, Mode extends string>(id: Id, mode: Mode, platform = "test") {
  return { id, version: "1.0.0", platform, mode };
}

export const TEST_OPERATOR_CLIENT = authClient(
  GATEWAY_CLIENT_NAMES.TEST,
  GATEWAY_CLIENT_MODES.TEST,
);
export const CONTROL_UI_CLIENT = authClient(
  GATEWAY_CLIENT_NAMES.CONTROL_UI,
  GATEWAY_CLIENT_MODES.WEBCHAT,
  "web",
);

export const TRUSTED_PROXY_CONTROL_UI_HEADERS = {
  origin: "https://localhost",
  "x-forwarded-for": "203.0.113.10",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "peter@example.com",
} as const;

export const NODE_CLIENT = authClient(GATEWAY_CLIENT_NAMES.NODE_HOST, GATEWAY_CLIENT_MODES.NODE);
export const BACKEND_GATEWAY_CLIENT = authClient(
  GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  GATEWAY_CLIENT_MODES.BACKEND,
  "node",
);

export async function expectHelloOkServerVersion(port: number, expectedVersion: string) {
  const ws = await openWs(port);
  try {
    const res = await connectReq(ws);
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ type: "hello-ok", server: { version: expectedVersion } });
  } finally {
    ws.close();
  }
}

export async function createSignedDevice(params: {
  token?: string | null;
  scopes: string[];
  clientId: string;
  clientMode: string;
  role?: "operator" | "node";
  identityPath?: string;
  nonce: string;
  signedAtMs?: number;
}) {
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
    await import("../infra/device-identity.js");
  const identity = params.identityPath
    ? loadOrCreateDeviceIdentity({ path: params.identityPath })
    : loadOrCreateDeviceIdentity();
  const signedAtMs = params.signedAtMs ?? Date.now();
  const payload = buildDeviceAuthPayload({
    ...params,
    deviceId: identity.deviceId,
    role: params.role ?? "operator",
    signedAtMs,
    token: params.token ?? null,
  });
  return {
    identity,
    signedAtMs,
    device: {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce: params.nonce,
    },
  };
}

export function resolveGatewayTokenOrEnv(): string {
  const configured = (testState.gatewayAuth as { token?: unknown } | undefined)?.token;
  const token = typeof configured === "string" ? configured : process.env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof token !== "string") {
    throw new Error("expected gateway token in test state or OPENCLAW_GATEWAY_TOKEN");
  }
  return token;
}

async function approvePendingPairingIfNeeded() {
  const { approveDevicePairing } = await import("../infra/device-pairing-approval.js");
  const { listDevicePairing } = await import("../infra/device-pairing.js");
  const pending = (await listDevicePairing()).pending.at(0);
  if (!pending?.requestId) {
    throw new Error("expected pending pairing request");
  }
  await approveDevicePairing(pending.requestId, {
    callerScopes: pending.scopes ?? ["operator.admin"],
  });
}

export async function configureTrustedProxyControlUiAuth() {
  const { replaceConfigFile } = await import("../config/config.js");
  testState.gatewayAuth = undefined;
  testState.gatewayControlUi = {
    ...testState.gatewayControlUi,
    allowedOrigins: ["https://localhost"],
  };
  await replaceConfigFile({
    nextConfig: {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
          },
        },
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: ["https://localhost"] },
      },
    },
    afterWrite: { mode: "auto" },
  });
}

export async function sendRawConnectReq(
  ws: WebSocket,
  params: {
    id: string;
    token?: string;
    device: { id: string; publicKey: string; signature: string; signedAt: number; nonce?: string };
  },
) {
  ws.send(
    JSON.stringify({
      type: "req",
      id: params.id,
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: TEST_OPERATOR_CLIENT,
        caps: [],
        role: "operator",
        auth: params.token ? { token: params.token } : undefined,
        device: params.device,
      },
    }),
  );
  return onceMessage<{
    type?: string;
    id?: string;
    ok?: boolean;
    payload?: Record<string, unknown> | null;
    error?: { message?: string; details?: { code?: string; reason?: string } };
  }>(ws, (frame) => frame.type === "res" && frame.id === params.id);
}

export async function startRateLimitedTokenServerWithPairedDeviceToken() {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
  } satisfies Record<string, unknown>;

  const { server, ws, port, prevToken } = await startServerWithClient(undefined, {
    controlUiEnabled: true,
  });
  const deviceIdentityPath = nextAuthIdentityPath("openclaw-auth-rate-limit");
  try {
    const { deviceToken } = await ensurePairedDeviceTokenForCurrentIdentity(ws, deviceIdentityPath);

    ws.close();
    return { server, port, prevToken, deviceToken: deviceToken ?? "", deviceIdentityPath };
  } catch (err) {
    ws.close();
    await server.close();
    restoreGatewayToken(prevToken);
    throw err;
  }
}

export async function ensurePairedDeviceTokenForCurrentIdentity(
  ws: WebSocket,
  deviceIdentityPath = nextAuthIdentityPath("openclaw-auth-device"),
) {
  if (!(await connectReq(ws, { token: "secret", deviceIdentityPath })).ok) {
    await approvePendingPairingIfNeeded();
  }
  const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
  const { getPairedDevice } = await import("../infra/device-pairing.js");
  const identity = loadOrCreateDeviceIdentity({ path: deviceIdentityPath });
  const paired = await getPairedDevice(identity.deviceId);
  const deviceToken = paired?.tokens?.operator?.token;
  expect(paired?.deviceId).toBe(identity.deviceId);
  if (!deviceToken) {
    throw new Error(`expected operator token for paired device ${identity.deviceId}`);
  }
  return { identity: { deviceId: identity.deviceId }, deviceToken, deviceIdentityPath };
}

export {
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startTestGatewayServer,
  startServer,
  startServerWithClient,
  testState,
  testTailscaleWhois,
  withGatewayServer,
} from "./test-helpers.js";
export { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
export { resolvePreauthHandshakeTimeoutMs } from "../../packages/gateway-client/src/timeouts.js";
export {
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/index.js";
export { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
export { withEnvAsync as withRuntimeVersionEnv } from "../test-utils/env.js";
