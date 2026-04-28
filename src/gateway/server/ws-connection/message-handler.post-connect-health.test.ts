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
  resolveConnectAuthStateMock,
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
      controlUi: {
        allowedOrigins: ["http://127.0.0.1:19001"],
        dangerouslyDisableDeviceAuth: true,
      },
    },
  })),
  resolveConnectAuthStateMock: vi.fn(),
  upsertPresenceMock: vi.fn(),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));

vi.mock("../../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
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

vi.mock("./auth-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-context.js")>();
  return {
    ...actual,
    resolveConnectAuthState: resolveConnectAuthStateMock,
  };
});

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
    resolveConnectAuthStateMock.mockResolvedValue({
      authResult: { ok: true, method: "none" },
      authOk: true,
      authMethod: "none",
      sharedAuthOk: false,
      sharedAuthProvided: false,
    });
  });

  it("uses the injected runtime-aware health refresh after hello", async () => {
    let resolveRefresh: (() => void) | undefined;
    const refreshHealthSnapshot = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => resolve({} as never);
        }),
    ) as GatewayRequestContext["refreshHealthSnapshot"];
    const socketSend = vi.fn((_payload: string, cb?: (err?: Error) => void) => {
      cb?.();
    });
    let onMessage: ((data: string) => void) | undefined;
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
    const send = vi.fn();
    const isClosed = vi.fn(() => false);
    let client: unknown = null;
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      allowTailscale: false,
    };

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq: {
        headers: { host: "127.0.0.1:19001", origin: "http://127.0.0.1:19001" },
        socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      connId: "conn-1",
      remoteAddr: "127.0.0.1",
      localAddr: "127.0.0.1",
      requestHost: "127.0.0.1:19001",
      requestOrigin: "http://127.0.0.1:19001",
      connectNonce: "nonce-1",
      getResolvedAuth: () => resolvedAuth,
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      buildRequestContext: () => ({}) as GatewayRequestContext,
      refreshHealthSnapshot,
      send,
      close: vi.fn(),
      isClosed,
      clearHandshakeTimer: vi.fn(),
      getClient: () => client as never,
      setClient: (next) => {
        client = next;
        return true;
      },
      setHandshakeState: vi.fn(),
      setCloseCause: vi.fn(),
      setLastFrameMeta: vi.fn(),
      originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
    });

    expect(onMessage).toBeDefined();

    onMessage?.(
      JSON.stringify({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "openclaw-control-ui",
            version: "dev",
            platform: "test",
            mode: "ui",
          },
          role: "operator",
          caps: [],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(socketSend).toHaveBeenCalled();
    });
    const hello = JSON.parse(socketSend.mock.calls[0]?.[0] ?? "{}") as { ok?: boolean };
    expect(hello.ok).toBe(true);

    await vi.waitFor(() => {
      expect(refreshHealthSnapshot).toHaveBeenCalledWith({ probe: true });
    });
    resolveRefresh?.();
  });

  it("bounds stalled connect auth after clearing the pre-auth timer", async () => {
    vi.useFakeTimers();
    const previousHandshakeTimeout = process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS;
    process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS = "25";
    let resolveAuth:
      | ((
          value: Awaited<ReturnType<typeof import("./auth-context.js").resolveConnectAuthState>>,
        ) => void)
      | undefined;
    resolveConnectAuthStateMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAuth = resolve;
      }),
    );

    try {
      let onMessage: ((data: string) => void) | undefined;
      const socket = {
        _receiver: {},
        send: vi.fn(),
        on: vi.fn((event: string, handler: (data: string) => void) => {
          if (event === "message") {
            onMessage = handler;
          }
          return socket;
        }),
      } as unknown as WebSocket;
      const close = vi.fn();
      const clearHandshakeTimer = vi.fn();
      const send = vi.fn();
      const setClient = vi.fn(() => true);
      const resolvedAuth: ResolvedGatewayAuth = {
        mode: "none",
        allowTailscale: false,
      };

      attachGatewayWsMessageHandler({
        socket,
        upgradeReq: {
          headers: { host: "127.0.0.1:19001", origin: "http://127.0.0.1:19001" },
          socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
        } as unknown as IncomingMessage,
        connId: "conn-stalled-auth",
        remoteAddr: "127.0.0.1",
        localAddr: "127.0.0.1",
        requestHost: "127.0.0.1:19001",
        requestOrigin: "http://127.0.0.1:19001",
        connectNonce: "nonce-stalled-auth",
        getResolvedAuth: () => resolvedAuth,
        gatewayMethods: [],
        events: [],
        extraHandlers: {},
        buildRequestContext: () => ({}) as GatewayRequestContext,
        refreshHealthSnapshot: vi.fn() as GatewayRequestContext["refreshHealthSnapshot"],
        send,
        close,
        isClosed: () => false,
        clearHandshakeTimer,
        getClient: () => null,
        setClient,
        setHandshakeState: vi.fn(),
        setCloseCause: vi.fn(),
        setLastFrameMeta: vi.fn(),
        originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
        logGateway: createLogger() as never,
        logHealth: createLogger() as never,
        logWsControl: createLogger() as never,
      });

      onMessage?.(
        JSON.stringify({
          type: "req",
          id: "connect-stalled-auth",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "openclaw-control-ui",
              version: "dev",
              platform: "test",
              mode: "ui",
            },
            role: "operator",
            caps: [],
          },
        }),
      );

      expect(clearHandshakeTimer).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(25);

      expect(close).toHaveBeenCalledWith(1008, "connect auth timeout");
      resolveAuth?.({
        authResult: { ok: true, method: "none" },
        authOk: true,
        authMethod: "none",
        sharedAuthOk: false,
        sharedAuthProvided: false,
      });
      await vi.runAllTimersAsync();

      expect(setClient).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      if (previousHandshakeTimeout === undefined) {
        delete process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS = previousHandshakeTimeout;
      }
      vi.useRealTimers();
    }
  });
});
