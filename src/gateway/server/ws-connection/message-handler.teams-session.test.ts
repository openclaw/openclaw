import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../../infra/device-identity.js";
import {
  getGatewayClientAuthorizationDomain,
  getGatewayClientTeamsSession,
} from "../../authorization/client-domain.js";
import { buildDeviceAuthPayload } from "../../device-auth.js";

const mocks = vi.hoisted(() => ({
  pairedPublicKey: "",
  resolveTeamsSessionFromRequest: vi.fn(),
  getPairedDevice: vi.fn(async () => null as unknown),
  requestDevicePairing: vi.fn(async () => null as unknown),
  approveDevicePairing: vi.fn(async () => null as unknown),
  ensureDeviceToken: vi.fn(async () => ({
    token: "member-device-token",
    role: "member",
    scopes: [],
    createdAtMs: 1,
  })),
  updatePairedDeviceMetadata: vi.fn(async () => undefined),
  loadConfig: vi.fn(() => ({
    gateway: {
      auth: { mode: "token" },
      controlUi: {
        allowedOrigins: ["https://gateway.example.com"],
        dangerouslyDisableDeviceAuth: true,
      },
    },
  })),
}));

vi.mock("../../teams-http.js", () => ({
  resolveTeamsSessionFromRequest: mocks.resolveTeamsSessionFromRequest,
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../../config/io.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
}));

vi.mock("../../../infra/device-pairing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../infra/device-pairing.js")>();
  return {
    ...actual,
    getPairedDevice: mocks.getPairedDevice,
    requestDevicePairing: mocks.requestDevicePairing,
    approveDevicePairing: mocks.approveDevicePairing,
    ensureDeviceToken: mocks.ensureDeviceToken,
    updatePairedDeviceMetadata: mocks.updatePairedDeviceMetadata,
    hasEffectivePairedDeviceRole: vi.fn(() => true),
    listApprovedPairedDeviceRoles: vi.fn(() => ["member"]),
    listEffectivePairedDeviceRoles: vi.fn(() => ["member"]),
  };
});

vi.mock("../../../infra/system-presence.js", () => ({
  upsertPresence: vi.fn(),
}));

vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: vi.fn(() => ({
    presence: [{ host: "192.168.1.99", deviceId: "other-device" }],
    health: { channels: { telegram: { accountId: "other-account" } } },
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
    sessionDefaults: {
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "main",
      scope: "per-sender",
    },
  })),
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
  incrementPresenceVersion: vi.fn(() => 2),
}));

import { attachGatewayWsMessageHandler } from "./message-handler.js";

const teamsSession = Object.freeze({
  id: "teams-session-1",
  accountId: "account-1",
  principalId: "principal-1",
  principal: Object.freeze({
    issuer: "openclaw-local",
    subject: "member@example.com",
    kind: "human" as const,
  }),
  domainId: "domain-1",
  state: "active" as const,
  createdAt: 1,
  expiresAt: Date.now() + 60_000,
  revokedAt: null,
  revokedByPrincipalId: null,
});

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function attachHarness() {
  let onMessage: ((data: string) => void) | undefined;
  const socketSend = vi.fn((_payload: string, cb?: (err?: Error) => void) => cb?.());
  const socket = {
    _receiver: {},
    send: socketSend,
    on: vi.fn((event: string, handler: (data: string) => void) => {
      if (event === "message") {
        onMessage = handler;
      }
      return socket;
    }),
  } as unknown as WebSocket;
  let client: unknown = null;
  const send = vi.fn();
  const close = vi.fn();
  const connectNonce = "member-connect-nonce";
  const logGateway = createLogger();
  const upgradeReq = {
    headers: {
      host: "gateway.example.com",
      origin: "https://gateway.example.com",
      cookie: "openclaw_teams_session=opaque-cookie-token",
    },
    socket: { localAddress: "127.0.0.1", remoteAddress: "203.0.113.8" },
  } as unknown as IncomingMessage;

  attachGatewayWsMessageHandler({
    socket,
    upgradeReq,
    connId: "member-conn-1",
    remoteAddr: "203.0.113.8",
    localAddr: "127.0.0.1",
    requestHost: "gateway.example.com",
    requestOrigin: "https://gateway.example.com",
    connectNonce,
    getResolvedAuth: () => ({ mode: "token", token: "shared-root-secret", allowTailscale: false }),
    gatewayMethods: [],
    events: [],
    extraHandlers: {},
    buildRequestContext: () => ({ broadcast: vi.fn() }) as never,
    refreshHealthSnapshot: vi.fn(async () => ({}) as never),
    send,
    close,
    isClosed: () => false,
    clearHandshakeTimer: vi.fn(),
    getClient: () => client as never,
    setClient: (next) => {
      client = next;
      return true;
    },
    setHandshakeState: vi.fn(),
    advanceHandshakePhase: vi.fn(),
    setCloseCause: vi.fn(),
    setLastFrameMeta: vi.fn(),
    originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
    logGateway: logGateway as never,
    logHealth: createLogger() as never,
    logWsControl: createLogger() as never,
  });
  if (!onMessage) {
    throw new Error("expected message listener");
  }
  return {
    close,
    connectNonce,
    send,
    sendConnect: (params: Record<string, unknown>) =>
      onMessage?.(JSON.stringify({ type: "req", id: "connect-1", method: "connect", params })),
    socketSend,
    logGateway,
    get client() {
      return client;
    },
  };
}

function baseConnectParams() {
  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "openclaw-control-ui",
      version: "dev",
      platform: "test",
      mode: "ui",
    },
    role: "member",
    scopes: [],
    caps: [],
  };
}

describe("Teams member websocket sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pairedPublicKey = "";
    mocks.resolveTeamsSessionFromRequest.mockReturnValue(undefined);
    mocks.getPairedDevice.mockResolvedValue(null);
    mocks.requestDevicePairing.mockResolvedValue(null);
    mocks.approveDevicePairing.mockResolvedValue(null);
  });

  it("does not let a generic shared gateway token mint a member human", async () => {
    const harness = attachHarness();
    harness.sendConnect({
      ...baseConnectParams(),
      auth: { token: "shared-root-secret" },
    });

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalled());
    expect(harness.client).toBeNull();
    expect(mocks.resolveTeamsSessionFromRequest).toHaveBeenCalledOnce();
    const errorFrame = harness.send.mock.calls.find(
      ([frame]) => (frame as { type?: string }).type === "res",
    )?.[0] as { error?: { message?: string } } | undefined;
    expect(errorFrame?.error?.message).toMatch(/unauthorized/i);
  });

  it("requires the signed nonce-bound browser device even when operator device auth is disabled", async () => {
    mocks.resolveTeamsSessionFromRequest.mockReturnValue(teamsSession);
    const harness = attachHarness();
    harness.sendConnect(baseConnectParams());

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalled());
    expect(harness.client).toBeNull();
    const errorFrame = harness.send.mock.calls.find(
      ([frame]) => (frame as { type?: string }).type === "res",
    )?.[0] as { error?: { message?: string } } | undefined;
    expect(errorFrame?.error?.message).toContain("device identity");
  });

  it("rejects operator scopes on a Teams member session", async () => {
    mocks.resolveTeamsSessionFromRequest.mockReturnValue(teamsSession);
    const harness = attachHarness();
    harness.sendConnect({
      ...baseConnectParams(),
      scopes: ["operator.admin"],
    });

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalled());
    expect(harness.client).toBeNull();
    const errorFrame = harness.send.mock.calls.find(
      ([frame]) => (frame as { type?: string }).type === "res",
    )?.[0] as { error?: { message?: string } } | undefined;
    expect(errorFrame?.error?.message).toBe("member sessions cannot request operator scopes");
  });

  it("binds the server-issued principal and exact session domain after signed-device verification", async () => {
    mocks.resolveTeamsSessionFromRequest.mockReturnValue(teamsSession);
    const identity = loadOrCreateDeviceIdentity();
    const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    mocks.getPairedDevice.mockResolvedValue({
      deviceId: identity.deviceId,
      publicKey,
      role: "member",
      roles: ["member"],
      scopes: [],
      approvedScopes: [],
      tokens: {
        member: {
          token: "existing-member-device-token",
          role: "member",
          scopes: [],
          createdAtMs: 1,
        },
      },
      platform: "test",
    });
    const harness = attachHarness();
    const signedAt = Date.now();
    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: "openclaw-control-ui",
      clientMode: "ui",
      role: "member",
      scopes: [],
      signedAtMs: signedAt,
      token: null,
      nonce: harness.connectNonce,
    });
    harness.sendConnect({
      ...baseConnectParams(),
      device: {
        id: identity.deviceId,
        publicKey,
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt,
        nonce: harness.connectNonce,
      },
    });

    await vi.waitFor(() => expect(harness.client).not.toBeNull());
    expect(harness.client).toMatchObject({ principal: teamsSession.principal });
    expect(getGatewayClientAuthorizationDomain(harness.client as never)).toEqual({
      id: teamsSession.domainId,
    });
    expect(getGatewayClientTeamsSession(harness.client as never)).toEqual({
      id: teamsSession.id,
      principalId: teamsSession.principalId,
      domainId: teamsSession.domainId,
    });
    expect(harness.socketSend).toHaveBeenCalled();
    const hello = harness.socketSend.mock.calls
      .map(
        ([framePayload]) =>
          JSON.parse(framePayload) as {
            payload?: {
              type?: string;
              features?: { events?: string[] };
              snapshot?: Record<string, unknown>;
            };
          },
      )
      .map((frame) => frame.payload)
      .find((frame) => frame?.type === "hello-ok");
    expect(hello?.features?.events).toEqual([]);
    expect(hello?.snapshot).toMatchObject({ presence: [], health: {} });
    expect(hello?.snapshot).not.toHaveProperty("sessionDefaults");
    expect(harness.logGateway.error).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("silently approves a signed scope-less member device under the authenticated account", async () => {
    mocks.resolveTeamsSessionFromRequest.mockReturnValue(teamsSession);
    const identity = loadOrCreateDeviceIdentity();
    const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    mocks.requestDevicePairing.mockResolvedValue({
      request: {
        requestId: "member-pairing-1",
        deviceId: identity.deviceId,
        publicKey,
        role: "member",
        roles: ["member"],
        scopes: [],
        silent: true,
      },
      created: true,
      superseded: [],
    });
    mocks.approveDevicePairing.mockResolvedValue({
      status: "approved",
      device: {
        deviceId: identity.deviceId,
        publicKey,
        role: "member",
        roles: ["member"],
        scopes: [],
        approvedScopes: [],
        tokens: {},
        approvedAtMs: Date.now(),
      },
    });
    const harness = attachHarness();
    const signedAt = Date.now();
    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: "openclaw-control-ui",
      clientMode: "ui",
      role: "member",
      scopes: [],
      signedAtMs: signedAt,
      token: null,
      nonce: harness.connectNonce,
    });
    harness.sendConnect({
      ...baseConnectParams(),
      device: {
        id: identity.deviceId,
        publicKey,
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt,
        nonce: harness.connectNonce,
      },
    });

    await vi.waitFor(() => expect(mocks.requestDevicePairing).toHaveBeenCalled());
    expect(mocks.requestDevicePairing).toHaveBeenCalledWith(
      expect.objectContaining({ role: "member", scopes: [], silent: true }),
    );
    await vi.waitFor(() => expect(mocks.approveDevicePairing).toHaveBeenCalled());
    expect(mocks.approveDevicePairing).toHaveBeenCalledWith(
      "member-pairing-1",
      expect.objectContaining({ approvedVia: "teams-session" }),
    );
    expect(harness.logGateway.error).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(harness.client).not.toBeNull());
    expect(getGatewayClientAuthorizationDomain(harness.client as never)).toEqual({
      id: teamsSession.domainId,
    });
    expect(harness.close).not.toHaveBeenCalled();
  });
});
