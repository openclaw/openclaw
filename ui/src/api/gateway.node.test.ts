/** @vitest-environment node */
import { createHash, webcrypto } from "node:crypto";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_SERVER_CAPS,
  type ConnectParams,
} from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePreviousConnectParams } from "../../../packages/gateway-protocol/src/connect-compatibility.test-support.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadDeviceAuthToken as loadScopedDeviceAuthToken,
  storeDeviceAuthToken as storeScopedDeviceAuthToken,
} from "../lib/nodes/index.ts";
import * as nodes from "../lib/nodes/index.ts";
import {
  createInitialDevicesState,
  revokeDeviceToken,
  rotateDeviceToken,
} from "../lib/nodes/page-operations.ts";
import {
  migrateSessionPlacementRecoveryScope,
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { expectSignedPayloadFields } from "./gateway-signature.test-support.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import type { GatewayBrowserClientOptions, GatewayHelloOk } from "./gateway.ts";

const realLoadOrCreateDeviceIdentity = nodes.loadOrCreateDeviceIdentity;
const recoveryMigrationRuntimeMock = vi.hoisted(() => ({
  loaded: vi.fn(),
  migrate: vi.fn(),
}));

vi.mock("../lib/sessions/session-placement-recovery-migration.runtime.ts", () => {
  recoveryMigrationRuntimeMock.loaded();
  return {
    default: (gatewayUrl: string, sourceScope: string, destinationScope: string) =>
      recoveryMigrationRuntimeMock.migrate(gatewayUrl, sourceScope, destinationScope),
  };
});

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const LEGACY_DEVICE_AUTH_STORAGE_KEY = "openclaw.device.auth.v1";
const DEFAULT_DEVICE_AUTH_STORAGE_KEY = `${LEGACY_DEVICE_AUTH_STORAGE_KEY}:${DEFAULT_GATEWAY_URL}`;
const STORED_CRED = "stored-device-token";
type DeviceIdentity = { deviceId: string; privateKey: string; publicKey: string };
const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;
const CONTROL_UI_BOOTSTRAP_OPERATOR_SCOPES = [
  "operator.approvals",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
] as const;
const CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
] as const;
const loadOrCreateDeviceIdentityMock = vi.hoisted(() => vi.fn<() => Promise<DeviceIdentity>>());
const signDevicePayloadMock = vi.hoisted(() =>
  vi.fn(async (_privateKeyBase64Url: string, _payload: string) => "signature"),
);

function loadDeviceAuthToken() {
  return loadScopedDeviceAuthToken({
    deviceId: "device-1",
    role: "operator",
    gatewayUrl: DEFAULT_GATEWAY_URL,
  });
}

function storeDeviceAuthToken(params: { deviceId?: string; token: string; scopes?: string[] }) {
  return storeScopedDeviceAuthToken({
    deviceId: "device-1",
    role: "operator",
    ...params,
    gatewayUrl: DEFAULT_GATEWAY_URL,
  });
}

function storeDeviceIdentity(deviceId: string) {
  localStorage.setItem(
    "openclaw-device-identity-v1",
    JSON.stringify({
      version: 1,
      deviceId,
      publicKey: "AA",
      privateKey: "AA",
      createdAtMs: 1,
    }),
  );
}

function deferDeviceIdentityDigest() {
  const digest = createDeferred<ArrayBuffer>();
  const digestMock = vi.fn(() => digest.promise);
  vi.stubGlobal("crypto", { subtle: { digest: digestMock } });
  return { digest, digestMock };
}

function deferRecoveryDigest() {
  const result = deferDeviceIdentityDigest();
  let requestId = 0;
  vi.stubGlobal("crypto", {
    randomUUID: () => `req-deferred-${++requestId}`,
    subtle: { digest: result.digestMock },
  });
  return result;
}

function seedRecovery(sessionKey: string, recoveryScope: string) {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const recovery = {
    sessionKey,
    messageId: "message",
    message: "retain credential ownership",
    target: { kind: "profile" as const, profileId: "aws" },
    agentId: "cloud",
    gatewayUrl: DEFAULT_GATEWAY_URL,
    recoveryScope,
    phase: "sending" as const,
  };
  expect(writeSessionPlacementRecovery(recovery)).toBe(true);
  return recovery;
}

function prepareSelfMutation() {
  localStorage.clear();
  storeDeviceIdentity("00");
  loadOrCreateDeviceIdentityMock.mockResolvedValue({
    deviceId: "00",
    privateKey: "private-key", // pragma: allowlist secret
    publicKey: "public-key", // pragma: allowlist secret
  });
  loadOrCreateDeviceIdentityMock.mockImplementationOnce(realLoadOrCreateDeviceIdentity);
  return deferDeviceIdentityDigest();
}

const selfGrant = { deviceId: "00", gatewayUrl: DEFAULT_GATEWAY_URL, role: "operator" };

function createDeviceTokenState(request: (method: string) => Promise<unknown>) {
  const state = createInitialDevicesState({
    client: {
      request: request as <T = unknown>(method: string, params?: unknown) => Promise<T>,
    },
    connected: true,
  });
  state.requestGeneration = 1;
  return state;
}

const { GatewayBrowserClient, GatewayRequestError } = await import("./gateway.ts");

const clients: InstanceType<typeof GatewayBrowserClient>[] = [];
function createClient(opts: Partial<GatewayBrowserClientOptions> = {}) {
  const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL, ...opts });
  clients.push(client);
  return client;
}

type ConnectFrame = { id: string; method: string; params: ConnectParams };

const REQUEST_FRAME_ID = "2:00000000-0000-4000-8000-000000000000";

type RequestTimingPayload = Parameters<
  NonNullable<GatewayBrowserClientOptions["onRequestTiming"]>
>[0];
type ConnectTimingPayload = Parameters<
  NonNullable<GatewayBrowserClientOptions["onConnectTiming"]>
>[0];

function connectTimingPayloads(
  mock: ReturnType<typeof vi.fn<(timing: ConnectTimingPayload) => void>>,
) {
  return mock.mock.calls.map(([payload]) => payload);
}

function stubInsecureCrypto() {
  // Real insecure contexts keep randomUUID/getRandomValues; only crypto.subtle
  // is gated to secure contexts.
  vi.stubGlobal("crypto", {
    randomUUID: () => "req-insecure",
    getRandomValues: (array: Uint8Array) => array.fill(7),
  });
}

function parseLatestConnectFrame(ws: MockWebSocket): ConnectFrame {
  return JSON.parse(ws.sent.at(-1) ?? "{}") as ConnectFrame;
}

async function continueConnect(
  ws: MockWebSocket,
  nonce = "nonce-1",
  challengeTs = 1_800_000_000_000,
  capabilities?: string[],
) {
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce, ts: challengeTs, ...(capabilities ? { capabilities } : {}) },
  });
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await vi.waitFor(() => {
      expect(ws.sent.length).toBeGreaterThan(0);
    });
  }
  return { ws, connectFrame: parseLatestConnectFrame(ws) };
}

function emitHello(
  ws: MockWebSocket,
  id: string | undefined,
  auth: Partial<NonNullable<GatewayHelloOk["auth"]>> = {},
  policy?: GatewayHelloOk["policy"],
) {
  ws.emitMessage({
    type: "res",
    id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [], ...auth },
      policy,
    },
  });
}

async function expectSocketClosed(ws: MockWebSocket) {
  await vi.waitFor(() => expect(ws.readyState).toBe(3), { interval: 1, timeout: 50 });
}

async function startConnect(client: InstanceType<typeof GatewayBrowserClient>, nonce = "nonce-1") {
  client.start();
  return await continueConnect(getLatestWebSocket(), nonce);
}

function emitAuthFailure(
  ws: MockWebSocket,
  id: string,
  code = "AUTH_TOKEN_MISMATCH",
  canRetryWithDeviceToken = false,
) {
  ws.emitMessage({
    type: "res",
    id,
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "unauthorized",
      details: { code, ...(canRetryWithDeviceToken ? { canRetryWithDeviceToken } : {}) },
    },
  });
}

describe("GatewayBrowserClient", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(nodes, "loadOrCreateDeviceIdentity").mockImplementation(
      loadOrCreateDeviceIdentityMock,
    );
    vi.spyOn(nodes, "signDevicePayload").mockImplementation(signDevicePayloadMock);
    vi.unstubAllGlobals();
    const storage = createStorageMock();
    wsInstances.length = 0;
    loadOrCreateDeviceIdentityMock.mockReset();
    signDevicePayloadMock.mockClear();
    recoveryMigrationRuntimeMock.loaded.mockClear();
    recoveryMigrationRuntimeMock.migrate.mockImplementation(migrateSessionPlacementRecoveryScope);
    loadOrCreateDeviceIdentityMock.mockResolvedValue({
      deviceId: "device-1",
      privateKey: "private-key", // pragma: allowlist secret
      publicKey: "public-key", // pragma: allowlist secret
    });

    vi.stubGlobal("localStorage", storage);
    stubWindowGlobals(storage);
    vi.stubGlobal("WebSocket", MockWebSocket);

    storeDeviceAuthToken({
      token: "stored-device-token",
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
    });
  });

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    { advertised: false, modelCatalog: { agentId: "alpha" } },
    { advertised: true, modelCatalog: { agentId: "alpha", sessionKey: "agent:alpha:saved" } },
  ])("connects with only advertised catalog input: %j", async ({ advertised, modelCatalog }) => {
    const client = createClient({ modelCatalog });
    client.start();
    const { connectFrame } = await continueConnect(
      getLatestWebSocket(),
      "catalog-challenge",
      1_800_000_000_000,
      advertised ? [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT] : undefined,
    );
    if (advertised) {
      expect(connectFrame.params?.modelCatalog).toEqual(modelCatalog);
      expect(connectFrame.params?.caps).toContain(GATEWAY_CLIENT_CAPS.MODEL_CATALOG_SNAPSHOT);
    } else {
      expect(validatePreviousConnectParams(connectFrame.params)).toBe(true);
      expect(connectFrame.params).not.toHaveProperty("modelCatalog");
      expect(connectFrame.params?.caps).not.toContain(GATEWAY_CLIENT_CAPS.MODEL_CATALOG_SNAPSHOT);
    }
  });

  it("does not publish hello when a response observer closes the browser socket", async () => {
    useNodeFakeTimers();
    const onHello = vi.fn();
    const onClose = vi.fn();
    const onConnectTiming = vi.fn<(timing: ConnectTimingPayload) => void>();
    const client = createClient({
      onHello,
      onClose,
      onConnectTiming,
      onRequestTiming: ({ method }) => {
        if (method === "connect") {
          client.forceReconnect("response observer closed");
        }
      },
    });
    const { ws, connectFrame } = await startConnect(client);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        auth: { role: "operator", deviceToken: "late-device-token", scopes: [] },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.lastClose).toEqual({ code: 4000, reason: "response observer closed" });
    expect(onHello).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(loadDeviceAuthToken()?.token).toBe(STORED_CRED);
    expect(connectTimingPayloads(onConnectTiming).some(({ phase }) => phase === "hello")).toBe(
      false,
    );
    ws.emitClose(4000, "response observer closed");
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 4000,
        reason: "response observer closed",
        willRetry: true,
      }),
    );
    expect(connectTimingPayloads(onConnectTiming).at(-1)?.phase).toBe("failed");
    await vi.advanceTimersByTimeAsync(800);
    expect(getLatestWebSocket()).not.toBe(ws);
  });

  it.each([
    {
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh)",
      maxTouchPoints: 0,
      family: "Mac",
    },
    {
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh)",
      maxTouchPoints: 5,
      family: "iPad",
    },
    { platform: "MacIntel", userAgent: "Mozilla/5.0 (iPad)", maxTouchPoints: 0, family: "iPad" },
    {
      platform: "MacIntel",
      userAgent: "Macintosh",
      maxTouchPoints: 5,
      family: undefined,
      options: { platform: "MacIntel" },
    },
  ])(
    "reports browser family $family without changing $platform",
    async ({ family, options, ...browser }) => {
      vi.stubGlobal("navigator", { ...browser, language: "en-US" });
      const client = createClient({ ...options });
      const { connectFrame } = await startConnect(client);
      expect(connectFrame.params?.client.platform).toBe(browser.platform);
      expect(connectFrame.params?.client.deviceFamily).toBe(family);
    },
  );

  it("uses native client metadata and its existing operator scope grant", async () => {
    const client = createClient({
      clientName: "openclaw-ios",
      clientBuildId: "build-a",
      mode: "ui",
      platform: "iOS 27.0.0",
      deviceFamily: "iPhone",
      instanceId: "ios-installation",
      scopes: ["operator.read", "operator.write"],
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.params?.client).toMatchObject({
      id: "openclaw-ios",
      buildId: "build-a",
      mode: "ui",
      platform: "iOS 27.0.0",
      deviceFamily: "iPhone",
      instanceId: "ios-installation",
    });
    expect(connectFrame.params?.scopes).toEqual(["operator.read", "operator.write"]);
  });

  it("signs device proof with Gateway time instead of browser wall-clock time", async () => {
    useNodeFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    const client = createClient({ token: "shared-auth-token" });
    client.start();

    const challengeTs = 1_700_000_000_123;
    const { connectFrame } = await continueConnect(
      getLatestWebSocket(),
      "nonce-clock-skew",
      challengeTs,
    );

    expect(connectFrame.params?.device?.signedAt).toBe(challengeTs);
    const signedPayload = signDevicePayloadMock.mock.calls.at(-1)?.[1];
    expectSignedPayloadFields(signedPayload, {
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
      token: "shared-auth-token",
      nonce: "nonce-clock-skew",
      signedAtMs: challengeTs,
    });
  });

  it("fails closed when a secure device challenge omits its Gateway timestamp", async () => {
    const client = createClient({ token: "shared-auth-token" });
    client.start();
    const ws = getLatestWebSocket();
    ws.emitOpen();
    ws.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-missing-time" },
    });

    await expectSocketClosed(ws);
    expect(ws.sent).toHaveLength(0);
    expect(ws.lastClose).toEqual({ code: 4008, reason: "connect failed" });
  });

  it.each([
    { bootstrapProfile: undefined, scopes: CONTROL_UI_BOOTSTRAP_OPERATOR_SCOPES },
    { bootstrapProfile: "owner" as const, scopes: CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES },
  ])(
    "selects bootstrap auth and its $bootstrapProfile scope grant ahead of shared auth",
    async ({ bootstrapProfile, scopes }) => {
      const { connectFrame } = await startConnect(
        createClient({
          url: "wss://gateway.example",
          token: "gateway-secret",
          bootstrapToken: "boot-1",
          bootstrapProfile,
        }),
      );
      expect(connectFrame.params.auth).toEqual({ bootstrapToken: "boot-1" });
      expect(connectFrame.params.scopes).toEqual([...scopes]);
      expectSignedPayloadFields(signDevicePayloadMock.mock.calls[0]?.[1], {
        scopes: [...scopes],
        token: "boot-1",
        nonce: "nonce-1",
      });
    },
  );

  it.each([
    {
      name: "SecurityError",
      message: "Cannot connect due to a security error.",
      code: "BROWSER_WEBSOCKET_SECURITY_ERROR",
      reason: "security error",
      guidance:
        "Browser refused the Gateway WebSocket for security reasons. Use wss:// when the Control UI is served over HTTPS/Tailscale Serve, or open the loopback dashboard at http://127.0.0.1:18789.",
    },
    {
      name: "TypeError",
      message: "constructor failed",
      code: "BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR",
      reason: "websocket error",
      guidance: "Could not create the Gateway WebSocket: constructor failed",
    },
  ])(
    "reports $name socket construction failures without retrying",
    async ({ name, message, code, reason, guidance }) => {
      vi.useFakeTimers();
      const onClose = vi.fn();
      vi.stubGlobal(
        "WebSocket",
        class {
          static OPEN = 1;
          constructor() {
            throw Object.assign(new Error(message), { name });
          }
        },
      );
      const client = createClient({
        url: "ws://gateway.example:18789",
        token: "shared-auth-token",
        onClose,
      });
      expect(() => client.start()).not.toThrow();
      expect(onClose).toHaveBeenCalledWith({
        code: 1006,
        reason,
        willRetry: false,
        error: {
          code,
          message: guidance,
          details: { code, browserErrorName: name, browserMessage: message },
        },
      });
      expect(wsInstances).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it("retains negative response payloads without leaking them into timing or error JSON", async () => {
    const onRequestTiming = vi.fn<(timing: RequestTimingPayload) => void>();
    const client = createClient({ token: "shared-auth-token", onRequestTiming });

    const { ws, connectFrame } = await startConnect(client);
    emitHello(ws, connectFrame.id);
    onRequestTiming.mockClear();

    const request = client.request("config.get", { token: "do-not-log" });
    const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
    expect(frame.method).toBe("config.get");

    ws.emitMessage({
      type: "res",
      id: frame.id,
      ok: false,
      payload: { runId: "browser-run", privateResult: "not-for-logs" },
      error: {
        code: "CONFIG_ERROR",
        message: "config failed",
        details: { reason: "busy" },
        retryable: true,
        retryAfterMs: 250,
      },
    });

    try {
      await request;
      throw new Error("expected config.get request to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayRequestError);
      expect(error).toMatchObject({
        name: "GatewayRequestError",
        code: "CONFIG_ERROR",
        gatewayCode: "CONFIG_ERROR",
        message: "config failed",
        details: { reason: "busy" },
        retryable: true,
        retryAfterMs: 250,
        responsePayload: { runId: "browser-run", privateResult: "not-for-logs" },
      });
      expect(JSON.stringify(error)).not.toContain("not-for-logs");
    }
    expect(onRequestTiming).toHaveBeenCalledTimes(1);
    expect(onRequestTiming.mock.calls[0]?.[0]).not.toHaveProperty("params");
    expect(JSON.stringify(onRequestTiming.mock.calls)).not.toContain("not-for-logs");
    expect(onRequestTiming.mock.calls[0]?.[0]).toMatchObject({
      id: frame.id,
      method: "config.get",
      ok: false,
      errorCode: "CONFIG_ERROR",
      startedAtMs: expect.any(Number),
      endedAtMs: expect.any(Number),
      durationMs: expect.any(Number),
    });
    const timing = onRequestTiming.mock.calls[0]?.[0];
    expect(timing?.durationMs).toBe(
      Math.max(0, (timing?.endedAtMs ?? 0) - (timing?.startedAtMs ?? 0)),
    );
  });

  it("keeps credentials and nonce values out of connect timing", async () => {
    const onConnectTiming = vi.fn<(timing: ConnectTimingPayload) => void>();
    vi.stubGlobal("performance", {
      now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(35).mockReturnValue(40),
    });
    const client = createClient({ token: "shared-auth-token", onConnectTiming });

    const { ws, connectFrame } = await startConnect(client, "nonce-secret");
    const sentPayloads = connectTimingPayloads(onConnectTiming);
    for (const payload of sentPayloads) {
      expect(payload).not.toHaveProperty("token");
      expect(payload).not.toHaveProperty("passwordValue");
      expect(payload).not.toHaveProperty("nonce");
      expect(JSON.stringify(payload)).not.toContain("shared-auth-token");
      expect(JSON.stringify(payload)).not.toContain("nonce-secret");
    }

    emitHello(ws, connectFrame.id);

    await vi.waitFor(() => {
      expect(connectTimingPayloads(onConnectTiming).at(-1)?.phase).toBe("hello");
    });
  });

  it("marks fallback connect timing when no challenge arrives", async () => {
    useNodeFakeTimers();
    const onConnectTiming = vi.fn<(timing: ConnectTimingPayload) => void>();
    const client = createClient({ token: "shared-auth-token", onConnectTiming });

    client.start();
    const ws = getLatestWebSocket();
    ws.emitOpen();
    await vi.advanceTimersByTimeAsync(750);

    expect(parseLatestConnectFrame(ws).params?.device?.signedAt).toBe(Date.now());
    expect(connectTimingPayloads(onConnectTiming).map((payload) => payload.phase)).toContain(
      "fallback",
    );
    expect(connectTimingPayloads(onConnectTiming).at(-1)).toMatchObject({
      phase: "request-sent",
      hasChallenge: false,
      usedFallback: true,
    });
  });

  it.each([0, -1])("enforces the UTF-8 payload limit with %d bytes remaining", async (delta) => {
    const method = "méthod.界";
    const params = { value: "🦞" };
    const maxPayload =
      new TextEncoder().encode(
        JSON.stringify({ type: "req", id: REQUEST_FRAME_ID, method, params }),
      ).byteLength + delta;
    const onHello = vi.fn();
    const client = createClient({ token: "shared-auth-token", onHello });
    const { ws, connectFrame } = await startConnect(client, `nonce-${method}-${delta}`);
    emitHello(
      ws,
      connectFrame.id,
      { role: "operator", scopes: [] },
      { maxPayload, maxBufferedBytes: maxPayload * 2, tickIntervalMs: 30_000 },
    );
    await vi.waitFor(() => expect(onHello).toHaveBeenCalledOnce());

    const sentBefore = ws.sent.length;
    const request = client.request(method, params);
    if (delta < 0) {
      await expect(request).rejects.toThrow("Request exceeds the Gateway payload limit");
      expect(ws.sent).toHaveLength(sentBefore);
    } else {
      const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
      expect(frame.method).toBe(method);
      expect(new TextEncoder().encode(ws.sent.at(-1)).byteLength).toBe(maxPayload);
      ws.emitMessage({ type: "res", id: frame.id, ok: true, payload: { ok: true } });
      await expect(request).resolves.toEqual({ ok: true });
    }
    expect(maxPayload).toBeGreaterThan(
      JSON.stringify({ type: "req", id: REQUEST_FRAME_ID, method, params }).length + delta,
    );
  });

  it("does not let a stale hello runtime import publish or migrate recovery", async () => {
    useNodeFakeTimers();
    const { digest, digestMock } = deferRecoveryDigest();
    const legacyScope = createHash("sha256").update(STORED_CRED).digest("hex");
    const recovery = seedRecovery("agent:cloud:stale", legacyScope);
    const onRecoveryScopeChange = vi.fn();
    const client = createClient({ onRecoveryScopeChange });

    const { ws: firstWs, connectFrame: firstConnect } = await startConnect(client);
    emitHello(firstWs, firstConnect.id, {
      deviceToken: STORED_CRED,
      recoveryMigrationAllowed: true,
      recoveryScope: "server-stale",
    });
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    expect(recoveryMigrationRuntimeMock.loaded).not.toHaveBeenCalled();
    expect(onRecoveryScopeChange).not.toHaveBeenCalled();

    const firstGeneration = client.connectionGeneration;
    firstWs.emitClose(1006, "socket lost");
    expect(client.connectionGeneration).toBeGreaterThan(firstGeneration);
    await vi.advanceTimersByTimeAsync(800);
    const secondWs = getLatestWebSocket();
    secondWs.emitOpen();

    digest.resolve(Uint8Array.from(createHash("sha256").update(STORED_CRED).digest()).buffer);
    await vi.waitFor(() => expect(recoveryMigrationRuntimeMock.loaded).toHaveBeenCalledOnce());

    expect(onRecoveryScopeChange).not.toHaveBeenCalled();
    expect(recoveryMigrationRuntimeMock.migrate).not.toHaveBeenCalled();
    expect(client.recoveryScopeReady).toBe(false);
    expect(
      readSessionPlacementRecovery(DEFAULT_GATEWAY_URL, legacyScope, recovery.sessionKey),
    ).toEqual(recovery);
    expect(
      readSessionPlacementRecovery(DEFAULT_GATEWAY_URL, "server-stale", recovery.sessionKey),
    ).toBeNull();

    secondWs.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-current", ts: 1_800_000_000_000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    const secondConnect = parseLatestConnectFrame(secondWs);
    emitHello(secondWs, secondConnect.id, {
      deviceToken: STORED_CRED,
      recoveryMigrationAllowed: true,
      recoveryScope: "server-current",
    });
    await vi.waitFor(() => expect(onRecoveryScopeChange).toHaveBeenCalledOnce());
    expect(recoveryMigrationRuntimeMock.migrate).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_GATEWAY_URL,
      legacyScope,
      "server-current",
    );
    expect(client.recoveryScopeReady).toBe(true);
    expect(client.recoveryScope).toBe("server-current");
    expect(
      readSessionPlacementRecovery(DEFAULT_GATEWAY_URL, legacyScope, recovery.sessionKey),
    ).toBeNull();
    expect(
      readSessionPlacementRecovery(DEFAULT_GATEWAY_URL, "server-stale", recovery.sessionKey),
    ).toBeNull();
    expect(
      readSessionPlacementRecovery(DEFAULT_GATEWAY_URL, "server-current", recovery.sessionKey),
    ).toEqual({ ...recovery, recoveryScope: "server-current" });
    const connectedGeneration = client.connectionGeneration;
    client.stop();
    expect(client.connectionGeneration).toBeGreaterThan(connectedGeneration);
    expect(client.recoveryScopeReady).toBe(false);
  });

  it("retires the previous recovery identity before publishing an unresolved legacy hello", async () => {
    useNodeFakeTimers();
    const onRecoveryScopeChange = vi.fn();
    const observedScopes: Array<{ scope: string; ready: boolean }> = [];
    const client = createClient({
      token: "test-auth-token",
      onRecoveryScopeChange,
      onHello: () =>
        observedScopes.push({ scope: client.recoveryScope, ready: client.recoveryScopeReady }),
    });
    const { ws: firstWs, connectFrame } = await startConnect(client);
    emitHello(firstWs, connectFrame.id, {
      scopes: ["operator.write"],
      deviceToken: STORED_CRED,
    });
    await vi.waitFor(() => expect(client.recoveryScopeReady).toBe(true));
    const previousScope = client.recoveryScope;
    expect(previousScope).toBe(createHash("sha256").update(STORED_CRED).digest("hex"));
    const { digest, digestMock } = deferRecoveryDigest();
    firstWs.emitClose(1006, "socket lost");
    expect(client.recoveryScope).toBe(previousScope);
    await vi.advanceTimersByTimeAsync(800);
    const nextWs = getLatestWebSocket();
    nextWs.emitOpen();
    nextWs.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "next", ts: 1_800_000_000_000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    emitHello(nextWs, parseLatestConnectFrame(nextWs).id, {
      scopes: ["operator.write"],
      deviceToken: "different-synthetic-device-token",
    });
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    expect(observedScopes.at(-1)).toEqual({ scope: "", ready: false });
    nextWs.emitClose(1006, "unresolved identity disconnected");
    digest.resolve(new ArrayBuffer(32));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.recoveryScope).toBe("");
    expect(client.recoveryScopeReady).toBe(false);
    expect(onRecoveryScopeChange).toHaveBeenCalledOnce();
  });

  it("keeps stale credential recovery isolated across a shared-browser principal switch", async () => {
    const legacyScope = createHash("sha256").update(STORED_CRED).digest("hex");
    const principalScope = "principal-recovery-scope";
    const recovery = seedRecovery("agent:cloud:shared-browser", legacyScope);
    const onRecoveryScopeChange = vi.fn();
    const client = createClient({ onRecoveryScopeChange });

    const { ws, connectFrame } = await startConnect(client);
    expect(connectFrame.params?.auth?.deviceToken).toBe(STORED_CRED);
    emitHello(ws, connectFrame.id, {
      scopes: ["operator.read"],
      recoveryScope: principalScope,
    });
    await vi.waitFor(() => expect(onRecoveryScopeChange).toHaveBeenCalledOnce());
    expect(client.recoveryScope).toBe(principalScope);
    expect(
      readSessionPlacementRecovery(DEFAULT_GATEWAY_URL, legacyScope, recovery.sessionKey),
    ).toEqual(recovery);
    expect(
      readSessionPlacementRecovery(DEFAULT_GATEWAY_URL, principalScope, recovery.sessionKey),
    ).toBeNull();
  });

  it("uses a Gateway-owned recovery scope without shared credentials on an insecure context", async () => {
    localStorage.clear();
    stubInsecureCrypto();
    const onRecoveryScopeChange = vi.fn();
    const client = createClient({ onRecoveryScopeChange });

    const { ws, connectFrame } = await startConnect(client);
    emitHello(ws, connectFrame.id, {
      scopes: ["operator.admin"],
      recoveryScope: "gateway-recovery-scope",
    });

    await vi.waitFor(() => expect(onRecoveryScopeChange).toHaveBeenCalledOnce());
    expect(connectFrame.params?.auth).toBeUndefined();
    expect(connectFrame.params?.device?.id).toBe("device-1");
    expect(client.recoveryScope).toBe("gateway-recovery-scope");
    expect(client.recoveryScopeReady).toBe(true);
  });

  it.each([false, true])(
    "persists the device token grant across hello (rotated=%s)",
    async (rotated) => {
      const token = rotated ? "rotated-device-token" : STORED_CRED;
      const { ws, connectFrame } = await startConnect(createClient({ token: "test-auth-token" }));
      emitHello(ws, connectFrame.id, { scopes: ["operator.read"], deviceToken: token });
      await vi.waitFor(() => {
        expect(loadDeviceAuthToken()).toMatchObject({
          token,
          scopes: rotated ? ["operator.read"] : [...CONTROL_UI_OPERATOR_SCOPES].toSorted(),
        });
      });
    },
  );

  it("recovers from event gaps even when the gap callback throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onGap = vi.fn(() => {
      throw new Error("gap callback failed");
    });
    const onEvent = vi.fn();
    const listener = vi.fn();
    const client = createClient({ token: "shared-auth-token", onGap, onEvent });

    client.addEventListener(listener);
    client.start();
    const ws = getLatestWebSocket();

    ws.emitMessage({ type: "event", event: "session.updated", seq: 1 });
    onEvent.mockClear();
    listener.mockClear();

    expect(() => ws.emitMessage({ type: "event", event: "session.updated", seq: 3 })).not.toThrow();

    expect(onGap).toHaveBeenCalledWith({ expected: 2, received: 3 });
    expect(ws.lastClose).toEqual({ code: 4000, reason: "event sequence gap" });
    expect(onEvent).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("[gateway] gap handler error:", expect.any(Error));

    onGap.mockClear();
    ws.emitMessage({ type: "event", event: "session.updated", seq: 4 });
    expect(onGap).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("preserves an explicit native password alongside its token on an insecure context", async () => {
    const token = "native-token";
    stubInsecureCrypto();

    const { connectFrame } = await startConnect(
      createClient({
        url: "ws://gateway.example:18789",
        token,
        password: "shared-password", // pragma: allowlist secret
      }),
    );

    expect(connectFrame.id).toBe("1:req-insecure");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth).toEqual({
      token,
      password: "shared-password", // pragma: allowlist secret
      deviceToken: undefined,
    });
    expect(connectFrame.params?.device?.id).toBe("device-1");
    expect(signDevicePayloadMock).toHaveBeenCalled();
  });

  it("reuses cached session reader credentials without requesting broader scopes", async () => {
    const scopes = ["operator.sessions.read"];
    const stored = storeDeviceAuthToken({
      token: STORED_CRED,
      scopes,
    });

    const { connectFrame } = await startConnect(createClient());

    expect(typeof connectFrame.id).toBe("string");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBeUndefined();
    expect(connectFrame.params?.auth?.password).toBeUndefined();
    expect(connectFrame.params?.auth?.deviceToken).toBe("stored-device-token");
    expect(connectFrame.params?.scopes).toEqual(stored.scopes);
    const signedPayload = signDevicePayloadMock.mock.calls[0]?.[1];
    expect(signDevicePayloadMock.mock.calls[0]?.[0]).toBe("private-key");
    expectSignedPayloadFields(signedPayload, {
      scopes: stored.scopes,
      token: "stored-device-token",
      nonce: "nonce-1",
    });
  });

  it("selects the replacement token after a successful self rotation retires the page epoch", async () => {
    const { digest, digestMock } = prepareSelfMutation();
    const state = createDeviceTokenState(async () => ({
      deviceId: "00",
      role: "operator",
      token: "replacement-device-token",
      scopes: ["operator.read"],
      rotatedAtMs: 1_800_000_000_000,
      tokenDelivery: "in-band",
    }));

    const operation = rotateDeviceToken(state, selfGrant);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);
    await expect(operation).resolves.toEqual({
      delivery: "in-band",
      token: "replacement-device-token",
    });

    vi.stubGlobal("crypto", webcrypto);
    const nextClient = createClient();
    const { connectFrame } = await startConnect(nextClient);
    expect(connectFrame.params?.auth).toMatchObject({
      deviceToken: "replacement-device-token",
    });
    nextClient.stop();
  });

  it("selects no revoked token after a successful self revocation retires the page epoch", async () => {
    const { digest, digestMock } = prepareSelfMutation();
    storeDeviceAuthToken({
      deviceId: "00",
      token: "revoked-device-token",
      scopes: ["operator.read"],
    });
    const state = createDeviceTokenState(async () => ({}));

    const operation = revokeDeviceToken(state, selfGrant);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);
    await operation;

    vi.stubGlobal("crypto", webcrypto);
    const nextClient = createClient();
    const { connectFrame } = await startConnect(nextClient);
    expect(connectFrame.params?.auth).toBeUndefined();
    nextClient.stop();
  });

  it("migrates the legacy device token store to the first gateway opened after upgrade", async () => {
    const legacyStore = localStorage.getItem(DEFAULT_DEVICE_AUTH_STORAGE_KEY);
    expect(legacyStore).not.toBeNull();
    localStorage.clear();
    localStorage.setItem(LEGACY_DEVICE_AUTH_STORAGE_KEY, legacyStore ?? "");

    const { connectFrame } = await startConnect(createClient());

    expect(connectFrame.params?.auth?.deviceToken).toBe(STORED_CRED);
    expect(localStorage.getItem(LEGACY_DEVICE_AUTH_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(DEFAULT_DEVICE_AUTH_STORAGE_KEY)).toBe(legacyStore);
  });

  it.each([
    ["/rosita/", "/rosita", "/wilfred"],
    ["/control?tenant=a", "/control?tenant=a", "/control?tenant=b"],
  ])(
    "isolates cached credentials for routes %s and %s from %s",
    async (storedRoute, firstRoute, secondRoute) => {
      localStorage.clear();
      const origin = "wss://gateway.example";
      for (const [route, token] of [
        [storedRoute, "first-token"],
        [secondRoute, "second-token"],
      ] as const) {
        storeScopedDeviceAuthToken({
          deviceId: "device-1",
          gatewayUrl: origin + route,
          role: "operator",
          token,
          scopes: [...CONTROL_UI_OPERATOR_SCOPES],
        });
      }
      const first = await startConnect(createClient({ url: origin + firstRoute }));
      expect(first.connectFrame.params.auth?.deviceToken).toBe("first-token");
      const second = await startConnect(createClient({ url: origin + secondRoute }), "nonce-2");
      expect(second.connectFrame.params.auth?.deviceToken).toBe("second-token");
    },
  );

  it("ignores cached operator device tokens that do not include read access", async () => {
    localStorage.clear();
    storeDeviceAuthToken({
      token: "under-scoped-device-token",
      scopes: [],
    });

    const { connectFrame } = await startConnect(createClient());

    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBeUndefined();
    const signedPayload = signDevicePayloadMock.mock.calls[0]?.[1];
    expectSignedPayloadFields(signedPayload, {
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
      token: "",
      nonce: "nonce-1",
    });
  });

  it.each([DEFAULT_GATEWAY_URL, "ws://[::1]:18789"])(
    "bounds cached-token retries on %s",
    async (url) => {
      useNodeFakeTimers();
      storeScopedDeviceAuthToken({
        deviceId: "device-1",
        gatewayUrl: url,
        role: "operator",
        token: STORED_CRED,
        scopes: [...CONTROL_UI_OPERATOR_SCOPES],
      });
      const client = createClient({ url, token: "shared-auth-token" });
      const { ws: firstWs, connectFrame: firstConnect } = await startConnect(client);
      expect(firstConnect.params?.auth?.token).toBe("shared-auth-token");
      expect(firstConnect.params?.auth?.password).toBe("shared-auth-token");
      expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

      emitAuthFailure(firstWs, firstConnect.id, "AUTH_TOKEN_MISMATCH", true);
      await expectSocketClosed(firstWs);
      firstWs.emitClose(4008, "connect failed");

      await vi.advanceTimersByTimeAsync(800);
      const secondWs = getLatestWebSocket();
      expect(secondWs).not.toBe(firstWs);
      const { connectFrame: secondConnect } = await continueConnect(secondWs, "nonce-2");
      expect(secondConnect.params?.auth?.token).toBe("shared-auth-token");
      expect(secondConnect.params?.auth?.password).toBe("shared-auth-token");
      expect(secondConnect.params?.auth?.deviceToken).toBe(STORED_CRED);
      emitAuthFailure(secondWs, secondConnect.id);
      await expectSocketClosed(secondWs);
      secondWs.emitClose(4008, "connect failed");
      expect(
        loadScopedDeviceAuthToken({ deviceId: "device-1", gatewayUrl: url, role: "operator" })
          ?.token,
      ).toBe("stored-device-token");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(2);
    },
  );

  it("stops reconnecting on token mismatch for DNS hosts beginning with a 127 label", async () => {
    useNodeFakeTimers();
    const onClose = vi.fn();

    const { ws: firstWs, connectFrame: firstConnect } = await startConnect(
      createClient({
        url: "ws://127.example.invalid:18789",
        token: "shared-auth-token",
        onClose,
      }),
    );
    expect(firstConnect.params?.auth?.token).toBe("shared-auth-token");
    expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

    emitAuthFailure(firstWs, firstConnect.id, "AUTH_TOKEN_MISMATCH", true);
    await expectSocketClosed(firstWs);
    firstWs.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);
    expect(onClose).toHaveBeenCalledWith({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
        retryable: false,
        retryAfterMs: undefined,
      },
      willRetry: false,
    });
  });

  it("does not auto-reconnect on PROTOCOL_MISMATCH", async () => {
    useNodeFakeTimers();

    const { ws: ws1, connectFrame: connect } = await startConnect(
      createClient({ token: "shared-auth-token" }),
    );

    ws1.emitMessage({
      type: "res",
      id: connect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "protocol mismatch",
        details: { code: "PROTOCOL_MISMATCH" },
      },
    });
    await expectSocketClosed(ws1);
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);
  });

  it.each([
    { code: "AUTH_DEVICE_TOKEN_MISMATCH", clear: true },
    { code: "AUTH_SCOPE_MISMATCH", clear: false },
  ])(
    "stops reconnecting on $code and clears the token only when revoked",
    async ({ code, clear }) => {
      useNodeFakeTimers();
      const { ws, connectFrame } = await startConnect(createClient());
      expect(connectFrame.params.auth?.deviceToken).toBe(STORED_CRED);
      emitAuthFailure(ws, connectFrame.id, code);
      await expectSocketClosed(ws);
      ws.emitClose(4008, "connect failed");
      const token = loadDeviceAuthToken();
      if (clear) {
        expect(token).toBeNull();
      } else {
        expect(token?.token).toBe(STORED_CRED);
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(1);
    },
  );
  it("uses a scoped device token when legacy cleanup fails", async () => {
    vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
      throw new Error("storage cleanup blocked");
    });
    const client = createClient();

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.params?.auth?.deviceToken).toBe(STORED_CRED);
  });
  it("cancels a scheduled reconnect when stopped before the retry fires", async () => {
    useNodeFakeTimers();
    const client = createClient({ token: "shared-auth-token" });
    client.start();
    getLatestWebSocket().emitClose(1006, "socket lost");
    client.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
