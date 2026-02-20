import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { withEnvAsync } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { getHandshakeTimeoutMs } from "./server-constants.js";
import {
  connectReq,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startGatewayServer,
  startServerWithClient,
  testTailscaleWhois,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function waitForWsClose(ws: WebSocket, timeoutMs: number): Promise<boolean> {
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

const openWs = async (port: number, headers?: Record<string, string>) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
};

const openTailscaleWs = async (port: number) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: {
      origin: "https://gateway.tailnet.ts.net",
      "x-forwarded-for": "100.64.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.tailnet.ts.net",
      "tailscale-user-login": "peter",
      "tailscale-user-name": "Peter",
    },
  });
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
};

const originForPort = (port: number) => `http://127.0.0.1:${port}`;

function restoreGatewayToken(prevToken: string | undefined) {
  if (prevToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
  }
}

async function withRuntimeVersionEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  return withEnvAsync(env, run);
}

const TEST_OPERATOR_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.TEST,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.TEST,
};

const CONTROL_UI_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
  version: "1.0.0",
  platform: "web",
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
};

async function expectHelloOkServerVersion(port: number, expectedVersion: string) {
  const ws = await openWs(port);
  try {
    const res = await connectReq(ws);
    expect(res.ok).toBe(true);
    const payload = res.payload as
      | {
          type?: unknown;
          server?: { version?: string };
        }
      | undefined;
    expect(payload?.type).toBe("hello-ok");
    expect(payload?.server?.version).toBe(expectedVersion);
  } finally {
    ws.close();
  }
}

async function expectMissingScopeAfterConnect(
  port: number,
  opts?: Parameters<typeof connectReq>[1],
) {
  const ws = await openWs(port);
  try {
    const res = await connectReq(ws, opts);
    expect(res.ok).toBe(true);
    const status = await rpcReq(ws, "status");
    expect(status.ok).toBe(false);
    expect(status.error?.message).toContain("missing scope");
  } finally {
    ws.close();
  }
}

async function createSignedDevice(params: {
  token: string;
  scopes: string[];
  clientId: string;
  clientMode: string;
  identityPath?: string;
  nonce?: string;
  signedAtMs?: number;
}) {
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
    await import("../infra/device-identity.js");
  const identity = params.identityPath
    ? loadOrCreateDeviceIdentity(params.identityPath)
    : loadOrCreateDeviceIdentity();
  const signedAtMs = params.signedAtMs ?? Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: "operator",
    scopes: params.scopes,
    signedAtMs,
    token: params.token,
    nonce: params.nonce,
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

function resolveGatewayTokenOrEnv(): string {
  const token =
    typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
      ? ((testState.gatewayAuth as { token?: string }).token ?? undefined)
      : process.env.OPENCLAW_GATEWAY_TOKEN;
  expect(typeof token).toBe("string");
  return String(token ?? "");
}

async function approvePendingPairingIfNeeded() {
  const { approveDevicePairing, listDevicePairing } = await import("../infra/device-pairing.js");
  const list = await listDevicePairing();
  const pending = list.pending.at(0);
  expect(pending?.requestId).toBeDefined();
  if (pending?.requestId) {
    await approveDevicePairing(pending.requestId);
  }
}

function isConnectResMessage(id: string) {
  return (o: unknown) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      return false;
    }
    const rec = o as Record<string, unknown>;
    return rec.type === "res" && rec.id === id;
  };
}

async function sendRawConnectReq(
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
    error?: { message?: string };
  }>(ws, isConnectResMessage(params.id));
}

async function startRateLimitedTokenServerWithPairedDeviceToken() {
  const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
  const { getPairedDevice } = await import("../infra/device-pairing.js");

  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;

  const { server, ws, port, prevToken } = await startServerWithClient();
  try {
    const initial = await connectReq(ws, { token: "secret" });
    if (!initial.ok) {
      await approvePendingPairingIfNeeded();
    }

    const identity = loadOrCreateDeviceIdentity();
    const paired = await getPairedDevice(identity.deviceId);
    const deviceToken = paired?.tokens?.operator?.token;
    expect(deviceToken).toBeDefined();

    ws.close();
    return { server, port, prevToken, deviceToken: String(deviceToken ?? "") };
  } catch (err) {
    ws.close();
    await server.close();
    restoreGatewayToken(prevToken);
    throw err;
  }
}

async function ensurePairedDeviceTokenForCurrentIdentity(ws: WebSocket): Promise<{
  identity: { deviceId: string };
  deviceToken: string;
}> {
  const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
  const { getPairedDevice } = await import("../infra/device-pairing.js");

  const res = await connectReq(ws, { token: "secret" });
  if (!res.ok) {
    await approvePendingPairingIfNeeded();
  }

  const identity = loadOrCreateDeviceIdentity();
  const paired = await getPairedDevice(identity.deviceId);
  const deviceToken = paired?.tokens?.operator?.token;
  expect(deviceToken).toBeDefined();
  return { identity: { deviceId: identity.deviceId }, deviceToken: String(deviceToken ?? "") };
}

describe("gateway server auth/connect", () => {
  describe("default auth (token)", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port: number;

    beforeAll(async () => {
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
    });

    test("closes silent handshakes after timeout", { timeout: 60_000 }, async () => {
      vi.useRealTimers();
      const prevHandshakeTimeout = process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
      process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS = "50";
      try {
        const ws = await openWs(port);
        const handshakeTimeoutMs = getHandshakeTimeoutMs();
        const closed = await waitForWsClose(ws, handshakeTimeoutMs + 250);
        expect(closed).toBe(true);
      } finally {
        if (prevHandshakeTimeout === undefined) {
          delete process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
        } else {
          process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS = prevHandshakeTimeout;
        }
      }
    });

    test("connect (req) handshake returns hello-ok payload", async () => {
      const { CONFIG_PATH, STATE_DIR } = await import("../config/config.js");
      const ws = await openWs(port);

      const res = await connectReq(ws);
      expect(res.ok).toBe(true);
      const payload = res.payload as
        | {
            type?: unknown;
            snapshot?: { configPath?: string; stateDir?: string };
          }
        | undefined;
      expect(payload?.type).toBe("hello-ok");
      expect(payload?.snapshot?.configPath).toBe(CONFIG_PATH);
      expect(payload?.snapshot?.stateDir).toBe(STATE_DIR);

      ws.close();
    });

    test("connect (req) handshake prefers service version fallback in hello-ok payload", async () => {
      await withRuntimeVersionEnv(
        {
          OPENCLAW_VERSION: " ",
          OPENCLAW_SERVICE_VERSION: "2.4.6-service",
          npm_package_version: "1.0.0-package",
        },
        async () => expectHelloOkServerVersion(port, "2.4.6-service"),
      );
    });

    test("connect (req) handshake prefers OPENCLAW_VERSION over service version", async () => {
      await withRuntimeVersionEnv(
        {
          OPENCLAW_VERSION: "9.9.9-cli",
          OPENCLAW_SERVICE_VERSION: "2.4.6-service",
          npm_package_version: "1.0.0-package",
        },
        async () => expectHelloOkServerVersion(port, "9.9.9-cli"),
      );
    });

    test("connect (req) handshake falls back to npm_package_version when higher-precedence env values are blank", async () => {
      await withRuntimeVersionEnv(
        {
          OPENCLAW_VERSION: " ",
          OPENCLAW_SERVICE_VERSION: "\t",
          npm_package_version: "1.0.0-package",
        },
        async () => expectHelloOkServerVersion(port, "1.0.0-package"),
      );
    });

    test("does not grant admin when scopes are empty", async () => {
      await expectMissingScopeAfterConnect(port, { scopes: [] });
    });

    test("ignores requested scopes when device identity is omitted", async () => {
      await expectMissingScopeAfterConnect(port, { device: null });
    });

    test("allows health when scopes are empty", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { scopes: [] });
        expect(res.ok).toBe(true);
        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("does not grant admin when scopes are omitted", async () => {
      const ws = await openWs(port);
      const token = resolveGatewayTokenOrEnv();

      const { randomUUID } = await import("node:crypto");
      const os = await import("node:os");
      const path = await import("node:path");
      // Fresh identity: avoid leaking prior scopes (presence merges lists).
      const { identity, device } = await createSignedDevice({
        token,
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
        identityPath: path.join(os.tmpdir(), `openclaw-test-device-${randomUUID()}.json`),
      });

      const connectRes = await sendRawConnectReq(ws, {
        id: "c-no-scopes",
        token,
        device,
      });
      expect(connectRes.ok).toBe(true);
      const helloOk = connectRes.payload as
        | {
            snapshot?: {
              presence?: Array<{ deviceId?: unknown; scopes?: unknown }>;
            };
          }
        | undefined;
      const presence = helloOk?.snapshot?.presence;
      expect(Array.isArray(presence)).toBe(true);
      const mine = presence?.find((entry) => entry.deviceId === identity.deviceId);
      expect(mine).toBeTruthy();
      const presenceScopes = Array.isArray(mine?.scopes) ? mine?.scopes : [];
      expect(presenceScopes).toEqual([]);
      expect(presenceScopes).not.toContain("operator.admin");

      const status = await rpcReq(ws, "status");
      expect(status.ok).toBe(false);
      expect(status.error?.message).toContain("missing scope");
      const health = await rpcReq(ws, "health");
      expect(health.ok).toBe(true);

      ws.close();
    });

    test("rejects device signature when scopes are omitted but signed with admin", async () => {
      const ws = await openWs(port);
      const token = resolveGatewayTokenOrEnv();

      const { device } = await createSignedDevice({
        token,
        scopes: ["operator.admin"],
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
      });

      const connectRes = await sendRawConnectReq(ws, {
        id: "c-no-scopes-signed-admin",
        token,
        device,
      });
      expect(connectRes.ok).toBe(false);
      expect(connectRes.error?.message ?? "").toContain("device signature invalid");
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    test("sends connect challenge on open", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const evtPromise = onceMessage<{
        type?: string;
        event?: string;
        payload?: Record<string, unknown> | null;
      }>(ws, (o) => o.type === "event" && o.event === "connect.challenge");
      await new Promise<void>((resolve) => ws.once("open", resolve));
      const evt = await evtPromise;
      const nonce = (evt.payload as { nonce?: unknown } | undefined)?.nonce;
      expect(typeof nonce).toBe("string");
      ws.close();
    });

    test("rejects protocol mismatch", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, {
          minProtocol: PROTOCOL_VERSION + 1,
          maxProtocol: PROTOCOL_VERSION + 2,
        });
        expect(res.ok).toBe(false);
      } catch {
        // If the server closed before we saw the frame, that's acceptable.
      }
      ws.close();
    });

    test("rejects non-connect first request", async () => {
      const ws = await openWs(port);
      ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
      const res = await onceMessage<{ type?: string; id?: string; ok?: boolean; error?: unknown }>(
        ws,
        (o) => o.type === "res" && o.id === "h1",
      );
      expect(res.ok).toBe(false);
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    test("requires nonce when host is non-local", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { host: "example.com" },
      });
      await new Promise<void>((resolve) => ws.once("open", resolve));

      const res = await connectReq(ws);
      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("device nonce required");
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    test(
      "invalid connect params surface in response and close reason",
      { timeout: 60_000 },
      async () => {
        const ws = await openWs(port);
        const closeInfoPromise = new Promise<{ code: number; reason: string }>((resolve) => {
          ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        });

        ws.send(
          JSON.stringify({
            type: "req",
            id: "h-bad",
            method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: "bad-client",
                version: "dev",
                platform: "web",
                mode: "webchat",
              },
              device: {
                id: 123,
                publicKey: "bad",
                signature: "bad",
                signedAt: "bad",
              },
            },
          }),
        );

        const res = await onceMessage<{
          ok: boolean;
          error?: { message?: string };
        }>(
          ws,
          (o) => (o as { type?: string }).type === "res" && (o as { id?: string }).id === "h-bad",
        );
        expect(res.ok).toBe(false);
        expect(String(res.error?.message ?? "")).toContain("invalid connect params");

        const closeInfo = await closeInfoPromise;
        expect(closeInfo.code).toBe(1008);
        expect(closeInfo.reason).toContain("invalid connect params");
      },
    );
  });

  describe("password auth", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port: number;

    beforeAll(async () => {
      testState.gatewayAuth = { mode: "password", password: "secret" };
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
    });

    test("accepts password auth when configured", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { password: "secret" });
      expect(res.ok).toBe(true);
      ws.close();
    });

    test("rejects invalid password", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { password: "wrong" });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("unauthorized");
      ws.close();
    });
  });

  describe("token auth", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port: number;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    });

    test("rejects invalid token", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { token: "wrong" });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("unauthorized");
      ws.close();
    });

    test("returns control ui hint when token is missing", async () => {
      const ws = await openWs(port, { origin: originForPort(port) });
      const res = await connectReq(ws, {
        skipDefaultAuth: true,
        client: {
          ...CONTROL_UI_CLIENT,
        },
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("Control UI settings");
      ws.close();
    });

    test("rejects control ui without device identity by default", async () => {
      const ws = await openWs(port, { origin: originForPort(port) });
      const res = await connectReq(ws, {
        token: "secret",
        device: null,
        client: {
          ...CONTROL_UI_CLIENT,
        },
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("secure context");
      ws.close();
    });
  });

  describe("explicit none auth", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port: number;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "none" };
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    });

    test("allows loopback connect without shared secret when mode is none", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { skipDefaultAuth: true });
      expect(res.ok).toBe(true);
      ws.close();
    });
  });

  describe("tailscale auth", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port: number;

    beforeAll(async () => {
      testState.gatewayAuth = { mode: "token", token: "secret", allowTailscale: true };
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
    });

    beforeEach(() => {
      testTailscaleWhois.value = { login: "peter", name: "Peter" };
    });

    afterEach(() => {
      testTailscaleWhois.value = null;
    });

    test("requires device identity when only tailscale auth is available", async () => {
      const ws = await openTailscaleWs(port);
      const res = await connectReq(ws, { token: "dummy", device: null });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("device identity required");
      ws.close();
    });

    test("allows shared token to skip device when tailscale auth is enabled", async () => {
      const ws = await openTailscaleWs(port);
      const res = await connectReq(ws, { token: "secret", device: null });
      expect(res.ok).toBe(true);
      const status = await rpcReq(ws, "status");
      expect(status.ok).toBe(false);
      expect(status.error?.message).toContain("missing scope");
      const health = await rpcReq(ws, "health");
      expect(health.ok).toBe(true);
      ws.close();
    });
  });

  test("rejects control ui without device identity even when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    const { server, ws, prevToken } = await startServerWithClient("secret", {
      wsHeaders: { origin: "http://127.0.0.1" },
    });
    const res = await connectReq(ws, {
      token: "secret",
      device: null,
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "1.0.0",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("secure context");
    ws.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("rejects control ui password-only auth when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    testState.gatewayAuth = { mode: "password", password: "secret" };
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, { origin: originForPort(port) });
      const res = await connectReq(ws, {
        password: "secret",
        device: null,
        client: {
          ...CONTROL_UI_CLIENT,
        },
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("secure context");
      ws.close();
    });
  });

  test("does not bypass pairing for control ui device identity when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      gateway: {
        trustedProxies: ["127.0.0.1"],
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    try {
      await withGatewayServer(async ({ port }) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: {
            origin: "https://localhost",
            "x-forwarded-for": "203.0.113.10",
          },
        });
        const challengePromise = onceMessage<{
          type?: string;
          event?: string;
          payload?: Record<string, unknown> | null;
        }>(ws, (o) => o.type === "event" && o.event === "connect.challenge");
        await new Promise<void>((resolve) => ws.once("open", resolve));
        const challenge = await challengePromise;
        const nonce = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
        expect(typeof nonce).toBe("string");
        const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
        const { device } = await createSignedDevice({
          token: "secret",
          scopes,
          clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
          nonce: String(nonce),
        });
        const res = await connectReq(ws, {
          token: "secret",
          scopes,
          device,
          client: {
            ...CONTROL_UI_CLIENT,
          },
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");
        ws.close();
      });
    } finally {
      restoreGatewayToken(prevToken);
    }
  });

  test("allows control ui with stale device identity when device auth is disabled", async () => {
    testState.gatewayControlUi = { dangerouslyDisableDeviceAuth: true };
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    try {
      await withGatewayServer(async ({ port }) => {
        const ws = await openWs(port, { origin: originForPort(port) });
        const { device } = await createSignedDevice({
          token: "secret",
          scopes: [],
          clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
          signedAtMs: Date.now() - 60 * 60 * 1000,
        });
        const res = await connectReq(ws, {
          token: "secret",
          scopes: ["operator.read"],
          device,
          client: {
            ...CONTROL_UI_CLIENT,
          },
        });
        expect(res.ok).toBe(true);
        expect((res.payload as { auth?: unknown } | undefined)?.auth).toBeUndefined();
        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(true);
        ws.close();
      });
    } finally {
      restoreGatewayToken(prevToken);
    }
  });

  test("accepts device token auth for paired device", async () => {
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const { deviceToken } = await ensurePairedDeviceTokenForCurrentIdentity(ws);

    ws.close();

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws2.once("open", resolve));
    const res2 = await connectReq(ws2, { token: deviceToken });
    expect(res2.ok).toBe(true);

    ws2.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("keeps shared-secret lockout separate from device-token auth", async () => {
    const { server, port, prevToken, deviceToken } =
      await startRateLimitedTokenServerWithPairedDeviceToken();
    try {
      const wsBadShared = await openWs(port);
      const badShared = await connectReq(wsBadShared, { token: "wrong", device: null });
      expect(badShared.ok).toBe(false);
      wsBadShared.close();

      const wsSharedLocked = await openWs(port);
      const sharedLocked = await connectReq(wsSharedLocked, { token: "secret", device: null });
      expect(sharedLocked.ok).toBe(false);
      expect(sharedLocked.error?.message ?? "").toContain("retry later");
      wsSharedLocked.close();

      const wsDevice = await openWs(port);
      const deviceOk = await connectReq(wsDevice, { token: deviceToken });
      expect(deviceOk.ok).toBe(true);
      wsDevice.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("keeps device-token lockout separate from shared-secret auth", async () => {
    const { server, port, prevToken, deviceToken } =
      await startRateLimitedTokenServerWithPairedDeviceToken();
    try {
      const wsBadDevice = await openWs(port);
      const badDevice = await connectReq(wsBadDevice, { token: "wrong" });
      expect(badDevice.ok).toBe(false);
      wsBadDevice.close();

      const wsDeviceLocked = await openWs(port);
      const deviceLocked = await connectReq(wsDeviceLocked, { token: "wrong" });
      expect(deviceLocked.ok).toBe(false);
      expect(deviceLocked.error?.message ?? "").toContain("retry later");
      wsDeviceLocked.close();

      const wsShared = await openWs(port);
      const sharedOk = await connectReq(wsShared, { token: "secret", device: null });
      expect(sharedOk.ok).toBe(true);
      wsShared.close();

      const wsDeviceReal = await openWs(port);
      const deviceStillLocked = await connectReq(wsDeviceReal, { token: deviceToken });
      expect(deviceStillLocked.ok).toBe(false);
      expect(deviceStillLocked.error?.message ?? "").toContain("retry later");
      wsDeviceReal.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires pairing for scope upgrades", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildDeviceAuthPayload } = await import("./device-auth.js");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { getPairedDevice } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const identityDir = await mkdtemp(join(tmpdir(), "openclaw-device-scope-"));
    const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
    const client = {
      id: GATEWAY_CLIENT_NAMES.TEST,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.TEST,
    };
    const buildDevice = (scopes: string[]) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role: "operator",
        scopes,
        signedAtMs,
        token: "secret",
      });
      return {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
      };
    };
    const initial = await connectReq(ws, {
      token: "secret",
      scopes: ["operator.read"],
      client,
      device: buildDevice(["operator.read"]),
    });
    if (!initial.ok) {
      await approvePendingPairingIfNeeded();
    }

    let paired = await getPairedDevice(identity.deviceId);
    expect(paired?.scopes).toContain("operator.read");

    ws.close();

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws2.once("open", resolve));
    const res = await connectReq(ws2, {
      token: "secret",
      scopes: ["operator.admin"],
      client,
      device: buildDevice(["operator.admin"]),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("pairing required");

    await approvePendingPairingIfNeeded();
    ws2.close();

    const ws3 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws3.once("open", resolve));
    const approved = await connectReq(ws3, {
      token: "secret",
      scopes: ["operator.admin"],
      client,
      device: buildDevice(["operator.admin"]),
    });
    expect(approved.ok).toBe(true);
    paired = await getPairedDevice(identity.deviceId);
    expect(paired?.scopes).toContain("operator.admin");

    ws3.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("single approval captures pending node and operator roles for the same device", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing } =
      await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();
    const identityDir = await mkdtemp(join(tmpdir(), "openclaw-device-scope-"));
    const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
    const client = {
      id: GATEWAY_CLIENT_NAMES.TEST,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.TEST,
    };
    const buildDevice = (role: "operator" | "node", scopes: string[], nonce?: string) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role,
        scopes,
        signedAtMs,
        token: "secret",
        nonce,
      });
      return {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      };
    };
    const connectWithNonce = async (role: "operator" | "node", scopes: string[]) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { host: "gateway.example" },
      });
      const challengePromise = onceMessage<{
        type?: string;
        event?: string;
        payload?: Record<string, unknown> | null;
      }>(socket, (o) => o.type === "event" && o.event === "connect.challenge");
      await new Promise<void>((resolve) => socket.once("open", resolve));
      const challenge = await challengePromise;
      const nonce = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
      expect(typeof nonce).toBe("string");
      const result = await connectReq(socket, {
        token: "secret",
        role,
        scopes,
        client,
        device: buildDevice(role, scopes, String(nonce)),
      });
      socket.close();
      return result;
    };

    const nodeConnect = await connectWithNonce("node", []);
    expect(nodeConnect.ok).toBe(false);
    expect(nodeConnect.error?.message ?? "").toContain("pairing required");

    const operatorConnect = await connectWithNonce("operator", ["operator.read", "operator.write"]);
    expect(operatorConnect.ok).toBe(false);
    expect(operatorConnect.error?.message ?? "").toContain("pairing required");

    const pending = await listDevicePairing();
    expect(pending.pending).toHaveLength(1);
    expect(pending.pending[0]?.roles).toEqual(expect.arrayContaining(["node", "operator"]));
    expect(pending.pending[0]?.scopes).toEqual(
      expect.arrayContaining(["operator.read", "operator.write"]),
    );
    if (!pending.pending[0]) {
      throw new Error("expected pending pairing request");
    }
    await approveDevicePairing(pending.pending[0].requestId);

    const paired = await getPairedDevice(identity.deviceId);
    expect(paired?.roles).toEqual(expect.arrayContaining(["node", "operator"]));
    expect(paired?.scopes).toEqual(expect.arrayContaining(["operator.read", "operator.write"]));

    const approvedOperatorConnect = await connectWithNonce("operator", ["operator.read"]);
    expect(approvedOperatorConnect.ok).toBe(true);

    const afterApproval = await listDevicePairing();
    expect(afterApproval.pending).toEqual([]);

    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows operator.read connect when device is paired with operator.admin", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const identityDir = await mkdtemp(join(tmpdir(), "openclaw-device-scope-"));
    const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
    const client = {
      id: GATEWAY_CLIENT_NAMES.TEST,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.TEST,
    };
    const buildDevice = (scopes: string[]) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role: "operator",
        scopes,
        signedAtMs,
        token: "secret",
      });
      return {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
      };
    };

    const initial = await connectReq(ws, {
      token: "secret",
      scopes: ["operator.admin"],
      client,
      device: buildDevice(["operator.admin"]),
    });
    if (!initial.ok) {
      await approvePendingPairingIfNeeded();
    }

    ws.close();

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws2.once("open", resolve));
    const res = await connectReq(ws2, {
      token: "secret",
      scopes: ["operator.read"],
      client,
      device: buildDevice(["operator.read"]),
    });
    expect(res.ok).toBe(true);
    ws2.close();

    const list = await listDevicePairing();
    expect(list.pending).toEqual([]);

    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows legacy paired devices missing role/scope metadata", async () => {
    const { resolvePairingPaths, readJsonFile } = await import("../infra/pairing-files.js");
    const { writeJsonAtomic } = await import("../infra/json-files.js");
    const { getPairedDevice } = await import("../infra/device-pairing.js");
    const {
      device,
      identity: { deviceId },
    } = await createSignedDevice({
      token: "secret",
      scopes: ["operator.read"],
      clientId: TEST_OPERATOR_CLIENT.id,
      clientMode: TEST_OPERATOR_CLIENT.mode,
    });
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    let ws2: WebSocket | undefined;
    try {
      const initial = await connectReq(ws, {
        token: "secret",
        scopes: ["operator.read"],
        client: TEST_OPERATOR_CLIENT,
        device,
      });
      if (!initial.ok) {
        await approvePendingPairingIfNeeded();
      }

      const initialPaired = await getPairedDevice(deviceId);
      expect(initialPaired?.roles).toContain("operator");
      expect(initialPaired?.scopes).toContain("operator.read");

      const { pairedPath } = resolvePairingPaths(undefined, "devices");
      const paired =
        (await readJsonFile<Record<string, Record<string, unknown>>>(pairedPath)) ?? {};
      const legacy = paired[deviceId];
      if (!legacy) {
        throw new Error(`Expected paired metadata for deviceId=${deviceId}`);
      }

      delete legacy.roles;
      delete legacy.scopes;
      await writeJsonAtomic(pairedPath, paired);
      ws.close();

      const wsReconnect = new WebSocket(`ws://127.0.0.1:${port}`);
      ws2 = wsReconnect;
      await new Promise<void>((resolve) => wsReconnect.once("open", resolve));
      const reconnect = await connectReq(wsReconnect, {
        token: "secret",
        scopes: ["operator.read"],
        client: TEST_OPERATOR_CLIENT,
        device,
      });
      expect(reconnect.ok).toBe(true);

      const repaired = await getPairedDevice(deviceId);
      expect(repaired?.roles).toContain("operator");
      expect(repaired?.scopes).toContain("operator.read");
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
      ws.close();
      ws2?.close();
    }
  });

  test("rejects revoked device token", async () => {
    const { revokeDeviceToken } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const { identity, deviceToken } = await ensurePairedDeviceTokenForCurrentIdentity(ws);

    await revokeDeviceToken({ deviceId: identity.deviceId, role: "operator" });

    ws.close();

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws2.once("open", resolve));
    const res2 = await connectReq(ws2, { token: deviceToken });
    expect(res2.ok).toBe(false);

    ws2.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  });

  // Remaining tests require isolated gateway state.
});
