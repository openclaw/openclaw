import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
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

    test("does not grant admin when scopes are empty", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { scopes: [] });
      expect(res.ok).toBe(true);

      const health = await rpcReq(ws, "health");
      expect(health.ok).toBe(false);
      expect(health.error?.message).toContain("missing scope");

      ws.close();
    });

    test("does not grant admin when scopes are omitted", async () => {
      const ws = await openWs(port);
      const token =
        typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
          ? ((testState.gatewayAuth as { token?: string }).token ?? undefined)
          : process.env.OPENCLAW_GATEWAY_TOKEN;
      expect(typeof token).toBe("string");

      const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
        await import("../infra/device-identity.js");
      const { randomUUID } = await import("node:crypto");
      const os = await import("node:os");
      const path = await import("node:path");
      // Fresh identity: avoid leaking prior scopes (presence merges lists).
      const identity = loadOrCreateDeviceIdentity(
        path.join(os.tmpdir(), `openclaw-test-device-${randomUUID()}.json`),
      );
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
        role: "operator",
        scopes: [],
        signedAtMs,
        token: token ?? null,
      });

      test("ignores requested scopes when device identity is omitted", async () => {
        const ws = await openWs(port);
        const res = await connectReq(ws, { device: null });
        expect(res.ok).toBe(true);

        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(false);
        expect(health.error?.message).toContain("missing scope");

        ws.close();
      });
      const device = {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
      };

      ws.send(
        JSON.stringify({
          type: "req",
          id: "c-no-scopes",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: GATEWAY_CLIENT_NAMES.TEST,
              version: "1.0.0",
              platform: "test",
              mode: GATEWAY_CLIENT_MODES.TEST,
            },
            caps: [],
            role: "operator",
            auth: token ? { token } : undefined,
            device,
          },
        }),
      );
      const connectRes = await onceMessage<{ ok: boolean; payload?: unknown }>(ws, (o) => {
        if (!o || typeof o !== "object" || Array.isArray(o)) {
          return false;
        }
        const rec = o as Record<string, unknown>;
        return rec.type === "res" && rec.id === "c-no-scopes";
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

      const health = await rpcReq(ws, "health");
      expect(health.ok).toBe(false);
      expect(health.error?.message).toContain("missing scope");

      ws.close();
    });

    test("rejects device signature when scopes are omitted but signed with admin", async () => {
      const ws = await openWs(port);
      const token =
        typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
          ? ((testState.gatewayAuth as { token?: string }).token ?? undefined)
          : process.env.OPENCLAW_GATEWAY_TOKEN;
      expect(typeof token).toBe("string");

      const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
        await import("../infra/device-identity.js");
      const identity = loadOrCreateDeviceIdentity();
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
        role: "operator",
        scopes: ["operator.admin"],
        signedAtMs,
        token: token ?? null,
      });
      const device = {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
      };

      ws.send(
        JSON.stringify({
          type: "req",
          id: "c-no-scopes-signed-admin",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: GATEWAY_CLIENT_NAMES.TEST,
              version: "1.0.0",
              platform: "test",
              mode: GATEWAY_CLIENT_MODES.TEST,
            },
            caps: [],
            role: "operator",
            auth: token ? { token } : undefined,
            device,
          },
        }),
      );
      const connectRes = await onceMessage<{ ok: boolean; error?: { message?: string } }>(
        ws,
        (o) => {
          if (!o || typeof o !== "object" || Array.isArray(o)) {
            return false;
          }
          const rec = o as Record<string, unknown>;
          return rec.type === "res" && rec.id === "c-no-scopes-signed-admin";
        },
      );
      expect(connectRes.ok).toBe(false);
      expect(connectRes.error?.message ?? "").toContain("device signature invalid");
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    test("sends connect challenge on open", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const evtPromise = onceMessage<{ payload?: unknown }>(
        ws,
        (o) => o.type === "event" && o.event === "connect.challenge",
      );
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
      const res = await onceMessage<{ ok: boolean; error?: unknown }>(
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
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "1.0.0",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
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
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "1.0.0",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("secure context");
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
      const health = await rpcReq(ws, "health");
      expect(health.ok).toBe(false);
      expect(health.error?.message).toContain("missing scope");
      ws.close();
    });
  });

  test("allows control ui without device identity when insecure auth is enabled", async () => {
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
    expect(res.ok).toBe(true);
    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  });

  test("allows control ui with device identity when insecure auth is enabled", async () => {
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
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: {
        origin: "https://localhost",
        "x-forwarded-for": "203.0.113.10",
      },
    });
    const challengePromise = onceMessage<{ payload?: unknown }>(
      ws,
      (o) => o.type === "event" && o.event === "connect.challenge",
    );
    await new Promise<void>((resolve) => ws.once("open", resolve));
    const challenge = await challengePromise;
    const nonce = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
    expect(typeof nonce).toBe("string");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const identity = loadOrCreateDeviceIdentity();
    const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
      role: "operator",
      scopes,
      signedAtMs,
      token: "secret",
      nonce: String(nonce),
    });
    const device = {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce: String(nonce),
    };
    const res = await connectReq(ws, {
      token: "secret",
      scopes,
      device,
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "1.0.0",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });
    expect(res.ok).toBe(true);
    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  });

  test("allows control ui with stale device identity when device auth is disabled", async () => {
    testState.gatewayControlUi = { dangerouslyDisableDeviceAuth: true };
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = await openWs(port, { origin: originForPort(port) });
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const identity = loadOrCreateDeviceIdentity();
    const signedAtMs = Date.now() - 60 * 60 * 1000;
    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
      role: "operator",
      scopes: [],
      signedAtMs,
      token: "secret",
    });
    const device = {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
    };
    const res = await connectReq(ws, {
      token: "secret",
      device,
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "1.0.0",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });
    expect(res.ok).toBe(true);
    expect((res.payload as { auth?: unknown } | undefined)?.auth).toBeUndefined();
    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  });

  test("accepts device token auth for paired device", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing } =
      await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const res = await connectReq(ws, { token: "secret" });
    if (!res.ok) {
      const list = await listDevicePairing();
      const pending = list.pending.at(0);
      expect(pending?.requestId).toBeDefined();
      if (pending?.requestId) {
        await approveDevicePairing(pending.requestId);
      }
    }

    const identity = loadOrCreateDeviceIdentity();
    const paired = await getPairedDevice(identity.deviceId);
    const deviceToken = paired?.tokens?.operator?.token;
    expect(deviceToken).toBeDefined();

    ws.close();

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws2.once("open", resolve));
    const res2 = await connectReq(ws2, { token: deviceToken });
    expect(res2.ok).toBe(true);

    ws2.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  });

  test("keeps shared-secret lockout separate from device-token auth", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing } =
      await import("../infra/device-pairing.js");
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    try {
      const ws = await openWs(port);
      const initial = await connectReq(ws, { token: "secret" });
      if (!initial.ok) {
        const list = await listDevicePairing();
        const pending = list.pending.at(0);
        expect(pending?.requestId).toBeDefined();
        if (pending?.requestId) {
          await approveDevicePairing(pending.requestId);
        }
      }
      const identity = loadOrCreateDeviceIdentity();
      const paired = await getPairedDevice(identity.deviceId);
      const deviceToken = paired?.tokens?.operator?.token;
      expect(deviceToken).toBeDefined();
      ws.close();

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
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }
  });

  test("keeps device-token lockout separate from shared-secret auth", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing } =
      await import("../infra/device-pairing.js");
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    try {
      const ws = await openWs(port);
      const initial = await connectReq(ws, { token: "secret" });
      if (!initial.ok) {
        const list = await listDevicePairing();
        const pending = list.pending.at(0);
        expect(pending?.requestId).toBeDefined();
        if (pending?.requestId) {
          await approveDevicePairing(pending.requestId);
        }
      }
      const identity = loadOrCreateDeviceIdentity();
      const paired = await getPairedDevice(identity.deviceId);
      const deviceToken = paired?.tokens?.operator?.token;
      expect(deviceToken).toBeDefined();
      ws.close();

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
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }
  });

  test("requires pairing for scope upgrades", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildDeviceAuthPayload } = await import("./device-auth.js");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing } =
      await import("../infra/device-pairing.js");
    const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
      await import("../utils/message-channel.js");
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
      const list = await listDevicePairing();
      const pending = list.pending.at(0);
      expect(pending?.requestId).toBeDefined();
      if (pending?.requestId) {
        await approveDevicePairing(pending.requestId);
      }
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
    expect(res.ok).toBe(true);
    paired = await getPairedDevice(identity.deviceId);
    expect(paired?.scopes).toContain("operator.admin");

    ws2.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  });

  test("rejects revoked device token", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, revokeDeviceToken } =
      await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const res = await connectReq(ws, { token: "secret" });
    if (!res.ok) {
      const list = await listDevicePairing();
      const pending = list.pending.at(0);
      expect(pending?.requestId).toBeDefined();
      if (pending?.requestId) {
        await approveDevicePairing(pending.requestId);
      }
    }

    const identity = loadOrCreateDeviceIdentity();
    const paired = await getPairedDevice(identity.deviceId);
    const deviceToken = paired?.tokens?.operator?.token;
    expect(deviceToken).toBeDefined();

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
