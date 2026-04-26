import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ResolvedGatewayAuth } from "../../auth.js";
import { PROTOCOL_VERSION } from "../../protocol/index.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";

const {
  buildGatewaySnapshotMock,
  getHealthCacheMock,
  getHealthVersionMock,
  incrementPresenceVersionMock,
  loadConfigMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  buildGatewaySnapshotMock: vi.fn(() => ({
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
    sessionDefaults: {
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "main",
      scope: "per-sender",
    },
  })),
  getHealthCacheMock: vi.fn(() => null),
  getHealthVersionMock: vi.fn(() => 1),
  incrementPresenceVersionMock: vi.fn(() => 2),
  loadConfigMock: vi.fn(() => ({
    gateway: {
      auth: { mode: "none" },
      controlUi: {},
    },
  })),
  upsertPresenceMock: vi.fn(),
}));

vi.mock("../../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../../../infra/system-presence.js", () => ({
  upsertPresence: upsertPresenceMock,
}));

vi.mock("../../server-methods.js", () => ({
  handleGatewayRequest: vi.fn(),
}));

vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: buildGatewaySnapshotMock,
  getHealthCache: getHealthCacheMock,
  getHealthVersion: getHealthVersionMock,
  incrementPresenceVersion: incrementPresenceVersionMock,
}));

import { attachGatewayWsMessageHandler } from "./message-handler.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("attachGatewayWsMessageHandler post-connect health refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the injected runtime-aware health refresh after hello", async () => {
    let resolveRefresh: (() => void) | undefined;
    const refreshHealthSnapshot = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => resolve({} as never);
        }),
    ) as GatewayRequestContext["refreshHealthSnapshot"];
    const socket = Object.assign(new EventEmitter(), {
      _receiver: {},
      send: vi.fn((_payload: string, cb?: (err?: Error) => void) => {
        cb?.();
      }),
    }) as unknown as WebSocket;
    let client: unknown = null;
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      allowTailscale: false,
    };

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq: {
        headers: { host: "127.0.0.1:19001" },
        socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      connId: "conn-1",
      remoteAddr: "127.0.0.1",
      localAddr: "127.0.0.1",
      requestHost: "127.0.0.1:19001",
      connectNonce: "nonce-1",
      getResolvedAuth: () => resolvedAuth,
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      buildRequestContext: () => ({}) as GatewayRequestContext,
      refreshHealthSnapshot,
      send: vi.fn(),
      close: vi.fn(),
      isClosed: () => false,
      clearHandshakeTimer: vi.fn(),
      getClient: () => client as never,
      setClient: (next) => {
        client = next;
      },
      setHandshakeState: vi.fn(),
      setCloseCause: vi.fn(),
      setLastFrameMeta: vi.fn(),
      originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "test",
            version: "dev",
            platform: "test",
            mode: "test",
          },
          auth: { token: "test-token" },
          role: "operator",
          caps: [],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(refreshHealthSnapshot).toHaveBeenCalledWith({ probe: true });
    });
    resolveRefresh?.();
  });
});
