import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import type { ResolvedGatewayAuth } from "../auth.js";

const { attachGatewayWsMessageHandlerMock, broadcastPresenceSnapshotMock, upsertPresenceMock } =
  vi.hoisted(() => ({
    attachGatewayWsMessageHandlerMock: vi.fn(),
    broadcastPresenceSnapshotMock: vi.fn(),
    upsertPresenceMock: vi.fn(),
  }));

vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachGatewayWsMessageHandlerMock,
}));
vi.mock("../../infra/system-presence.js", () => ({
  upsertPresence: upsertPresenceMock,
}));
vi.mock("./presence-events.js", () => ({
  broadcastPresenceSnapshot: broadcastPresenceSnapshotMock,
}));

import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import { resolveSharedGatewaySessionGeneration } from "./ws-shared-generation.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createResolvedAuth(token: string): ResolvedGatewayAuth {
  return {
    mode: "token",
    allowTailscale: false,
    token,
  };
}

async function waitForLazyMessageHandler() {
  await vi.dynamicImportSettled();
}

type TestSocket = EventEmitter & {
  _socket: {
    remoteAddress: string;
    remotePort: number;
    localAddress: string;
    localPort: number;
  };
  send: ReturnType<typeof vi.fn>;
  ping?: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function createTestSocket(params: { ping?: boolean } = {}): TestSocket {
  return Object.assign(new EventEmitter(), {
    _socket: {
      remoteAddress: "127.0.0.1",
      remotePort: 1234,
      localAddress: "127.0.0.1",
      localPort: 5678,
    },
    send: vi.fn(),
    ...(params.ping ? { ping: vi.fn() } : {}),
    close: vi.fn(),
  });
}

async function connectTestWs(
  params: {
    host?: string;
    headers?: Record<string, string>;
    socket?: TestSocket;
    clients?: Set<unknown>;
    options?: Partial<Parameters<typeof attachGatewayWsConnectionHandler>[0]>;
  } = {},
) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const wss = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
    }),
  } as unknown as WebSocketServer;
  const socket = params.socket ?? createTestSocket();
  const upgradeReq = {
    headers: { host: params.host ?? "127.0.0.1:19001", ...params.headers },
    socket: { localAddress: "127.0.0.1" },
  };
  const clients = params.clients ?? new Set<unknown>();
  const logWsControl = createLogger();

  attachGatewayWsConnectionHandler({
    wss,
    clients: clients as never,
    preauthConnectionBudget: { release: vi.fn() } as never,
    port: 19001,
    resolvedAuth: createResolvedAuth("token"),
    preauthHandshakeTimeoutMs: 60_000,
    gatewayMethods: [],
    events: [],
    refreshHealthSnapshot: vi.fn(async () => ({}) as never),
    logGateway: createLogger() as never,
    logHealth: createLogger() as never,
    logWsControl: logWsControl as never,
    extraHandlers: {},
    broadcast: vi.fn(),
    buildRequestContext: () =>
      ({
        unsubscribeAllSessionEvents: vi.fn(),
        nodeRegistry: { unregister: vi.fn() },
        nodeUnsubscribeAll: vi.fn(),
      }) as never,
    ...params.options,
  });

  const onConnection = listeners.get("connection");
  expect(onConnection).toBeTypeOf("function");
  onConnection?.(socket, upgradeReq);
  await waitForLazyMessageHandler();

  return {
    clients,
    socket,
    logWsControl,
    passed: attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0] as unknown,
  };
}

describe("attachGatewayWsConnectionHandler", () => {
  beforeEach(() => {
    attachGatewayWsMessageHandlerMock.mockReset();
    broadcastPresenceSnapshotMock.mockReset();
    upsertPresenceMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("threads current auth getters into the handshake handler instead of a stale snapshot", async () => {
    const initialAuth = createResolvedAuth("token-before");
    let currentAuth = initialAuth;

    const { passed } = await connectTestWs({
      options: {
        resolvedAuth: initialAuth,
        getResolvedAuth: () => currentAuth,
      },
    });

    expect(attachGatewayWsMessageHandlerMock).toHaveBeenCalledTimes(1);
    const handlerParams = passed as {
      getResolvedAuth: () => ResolvedGatewayAuth;
      getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
    };

    currentAuth = createResolvedAuth("token-after");

    expect(handlerParams.getResolvedAuth()).toMatchObject({ token: "token-after" });
    expect(handlerParams.getRequiredSharedGatewaySessionGeneration?.()).toBe(
      resolveSharedGatewaySessionGeneration(currentAuth),
    );
  });

  it("threads generic plugin surface URLs into the handshake handler", async () => {
    const { passed } = await connectTestWs({
      host: "gateway.example.com",
      options: {
        port: 18789,
        pluginSurfaceScheme: "https",
        getPluginNodeCapabilities: () => [{ surface: "canvas", ttlMs: 1234 }],
      },
    });

    const handlerParams = passed as {
      pluginSurfaceBaseUrl?: string;
      pluginNodeCapabilities?: Array<{ surface: string; ttlMs?: number }>;
    };
    expect(handlerParams.pluginSurfaceBaseUrl).toBe("https://gateway.example.com:443");
    expect(handlerParams.pluginNodeCapabilities).toEqual([{ surface: "canvas", ttlMs: 1234 }]);
  });

  it("prefers forwarded host over bind host for generic plugin surface URLs", async () => {
    const { passed } = await connectTestWs({
      host: "10.0.0.2:18789",
      headers: {
        "x-forwarded-host": "gateway.example.com",
        "x-forwarded-proto": "https",
      },
      options: {
        gatewayHost: "10.0.0.2",
        port: 18789,
        pluginSurfaceScheme: "http",
        getPluginNodeCapabilities: () => [{ surface: "canvas" }],
      },
    });

    const handlerParams = passed as {
      pluginSurfaceBaseUrl?: string;
    };
    expect(handlerParams.pluginSurfaceBaseUrl).toBe("https://gateway.example.com:443");
  });

  it("rejects late client registration after a pre-connect socket close", async () => {
    const clients = new Set();
    const { passed, socket } = await connectTestWs({ clients });
    const handlerParams = passed as {
      setClient: (client: unknown) => boolean;
    };
    socket.emit("close", 1001, Buffer.from("client left"));

    const registered = handlerParams.setClient({
      socket,
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      connId: "late-client",
      usesSharedGatewayAuth: false,
    });

    expect(registered).toBe(false);
    expect(clients.size).toBe(0);
  });

  it("sends protocol pings until the connection closes", async () => {
    vi.useFakeTimers();
    const socket = createTestSocket({ ping: true });
    const { passed } = await connectTestWs({ socket });
    const handlerParams = passed as {
      setClient: (client: unknown) => boolean;
    };
    expect(
      handlerParams.setClient({
        socket,
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
        connId: "ping-client",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);

    socket.emit("close", 1000, Buffer.from("done"));
    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
  });

  it("exposes a monotonic handshake phase tracker that starts at ws_upgrade_started", async () => {
    const { passed } = await connectTestWs();
    const handlerParams = passed as {
      advanceHandshakePhase: (phase: string) => void;
    };
    expect(handlerParams.advanceHandshakePhase).toBeTypeOf("function");
    expect(() => handlerParams.advanceHandshakePhase("ready")).not.toThrow();
    expect(() => handlerParams.advanceHandshakePhase("auth_token_received")).not.toThrow();
  });

  it("includes the last-completed handshake phase in the pre-connect close log", async () => {
    const { socket, logWsControl } = await connectTestWs();

    socket.emit("close", 1006, Buffer.from("client disappeared"));

    expect(logWsControl.warn).toHaveBeenCalled();
    const [message, context] = logWsControl.warn.mock.calls[0] as [
      string,
      { phase?: string; cause?: string },
    ];
    expect(message).toContain("closed before connect");
    expect(message).toContain("phase=ws_upgrade_started");
    expect(context).toMatchObject({ phase: "ws_upgrade_started" });
  });

  it("includes the last-completed handshake phase on handshake timeout", async () => {
    vi.useFakeTimers();
    const { logWsControl } = await connectTestWs({
      options: { preauthHandshakeTimeoutMs: 100 },
    });

    vi.advanceTimersByTime(150);

    expect(logWsControl.warn).toHaveBeenCalledWith(
      expect.stringContaining("phase=ws_upgrade_started"),
    );
    expect(logWsControl.warn).toHaveBeenCalledWith(expect.stringContaining("handshake timeout"));
  });

  it("omits the handshake phase from close logs once the session reaches ready", async () => {
    const { socket, logWsControl, passed } = await connectTestWs();
    const handlerParams = passed as {
      advanceHandshakePhase: (phase: string) => void;
      setHandshakeState: (state: "pending" | "connected" | "failed") => void;
      setClient: (client: unknown) => boolean;
    };
    handlerParams.advanceHandshakePhase("auth_token_received");
    handlerParams.advanceHandshakePhase("auth_validated");
    handlerParams.setHandshakeState("connected");
    handlerParams.advanceHandshakePhase("session_attached");
    expect(
      handlerParams.setClient({
        socket,
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
        connId: "ready-conn",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);
    handlerParams.advanceHandshakePhase("subscriptions_registered");
    handlerParams.advanceHandshakePhase("ready");

    socket.emit("close", 1000, Buffer.from("normal"));

    for (const call of logWsControl.warn.mock.calls) {
      const [message, context] = call as [string, Record<string, unknown> | undefined];
      expect(message).not.toContain("phase=");
      if (context) {
        expect(context).not.toHaveProperty("phase");
      }
    }
  });

  it("skips node presence disconnects for stale reconnected sockets", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const unregister = vi.fn(() => null);
    const wss = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
    } as unknown as WebSocketServer;
    const socket = Object.assign(new EventEmitter(), {
      _socket: {
        remoteAddress: "127.0.0.1",
        remotePort: 1234,
        localAddress: "127.0.0.1",
        localPort: 5678,
      },
      send: vi.fn(),
      close: vi.fn(),
    });
    const upgradeReq = {
      headers: { host: "127.0.0.1:19001" },
      socket: { localAddress: "127.0.0.1" },
    };

    attachGatewayWsConnectionHandler({
      wss,
      clients: new Set(),
      preauthConnectionBudget: { release: vi.fn() } as never,
      port: 19001,
      resolvedAuth: createResolvedAuth("token"),
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(),
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
      extraHandlers: {},
      broadcast: vi.fn(),
      buildRequestContext: () =>
        ({
          unsubscribeAllSessionEvents: vi.fn(),
          nodeRegistry: { unregister },
          nodeUnsubscribeAll: vi.fn(),
        }) as never,
    });

    const onConnection = listeners.get("connection");
    expect(onConnection).toBeTypeOf("function");
    onConnection?.(socket, upgradeReq);
    await waitForLazyMessageHandler();

    const passed = attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0] as {
      setClient: (client: unknown) => boolean;
    };
    expect(
      passed.setClient({
        socket,
        connect: {
          role: "node",
          client: { id: "openclaw-macos", mode: "node" },
          device: { id: "node-1" },
        },
        connId: "conn-old",
        presenceKey: "node-1",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    socket.emit("close", 1000, Buffer.from("stale"));

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(upsertPresenceMock).not.toHaveBeenCalled();
    expect(broadcastPresenceSnapshotMock).not.toHaveBeenCalled();
  });
});
