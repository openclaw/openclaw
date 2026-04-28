import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import type { ResolvedGatewayAuth } from "../auth.js";

const { attachGatewayWsMessageHandlerMock } = vi.hoisted(() => ({
  attachGatewayWsMessageHandlerMock: vi.fn(),
}));

vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachGatewayWsMessageHandlerMock,
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

function createConnectionHarness(url?: string) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
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
  const release = vi.fn();

  attachGatewayWsConnectionHandler({
    wss,
    clients: new Set(),
    preauthConnectionBudget: { release } as never,
    port: 19001,
    canvasHostEnabled: false,
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
        nodeRegistry: { unregister: vi.fn() },
        nodeUnsubscribeAll: vi.fn(),
      }) as never,
  });

  const onConnection = listeners.get("connection");
  expect(onConnection).toBeTypeOf("function");
  onConnection?.(socket, {
    url,
    headers: { host: "127.0.0.1:19001" },
    socket: { localAddress: "127.0.0.1" },
  });

  return { socket, release };
}

describe("attachGatewayWsConnectionHandler", () => {
  beforeEach(() => {
    attachGatewayWsMessageHandlerMock.mockReset();
  });

  it("rejects legacy websocket query auth on the ws path before the handshake", () => {
    const { socket, release } = createConnectionHarness("/ws?agent=main&token=legacy-token");

    expect(socket.close).toHaveBeenCalledWith(
      1008,
      "legacy websocket query auth is unsupported; use connect handshake",
    );
    expect(socket.send).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(attachGatewayWsMessageHandlerMock).not.toHaveBeenCalled();
  });

  it("rejects legacy websocket query auth on the root gateway path", () => {
    const { socket } = createConnectionHarness("/?agent=main&password=legacy-password");

    expect(socket.close).toHaveBeenCalledWith(
      1008,
      "legacy websocket query auth is unsupported; use connect handshake",
    );
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("does not treat token-only websocket query strings as legacy agent query auth", () => {
    const { socket } = createConnectionHarness("/ws?token=kept-for-compat");

    expect(socket.close).not.toHaveBeenCalled();
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      type: "event",
      event: "connect.challenge",
    });
    expect(attachGatewayWsMessageHandlerMock).toHaveBeenCalledTimes(1);
  });

  it("threads current auth getters into the handshake handler instead of a stale snapshot", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
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
    const initialAuth = createResolvedAuth("token-before");
    let currentAuth = initialAuth;

    attachGatewayWsConnectionHandler({
      wss,
      clients: new Set(),
      preauthConnectionBudget: { release: vi.fn() } as never,
      port: 19001,
      canvasHostEnabled: false,
      resolvedAuth: initialAuth,
      getResolvedAuth: () => currentAuth,
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(async () => ({}) as never),
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
      extraHandlers: {},
      broadcast: vi.fn(),
      buildRequestContext: () =>
        ({
          unsubscribeAllSessionEvents: vi.fn(),
          nodeRegistry: { unregister: vi.fn() },
          nodeUnsubscribeAll: vi.fn(),
        }) as never,
    });

    const onConnection = listeners.get("connection");
    expect(onConnection).toBeTypeOf("function");
    onConnection?.(socket, upgradeReq);

    expect(attachGatewayWsMessageHandlerMock).toHaveBeenCalledTimes(1);
    const passed = attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0] as {
      getResolvedAuth: () => ResolvedGatewayAuth;
      getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
    };

    currentAuth = createResolvedAuth("token-after");

    expect(passed.getResolvedAuth()).toMatchObject({ token: "token-after" });
    expect(passed.getRequiredSharedGatewaySessionGeneration?.()).toBe(
      resolveSharedGatewaySessionGeneration(currentAuth),
    );
  });

  it("rejects late client registration after a pre-connect socket close", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
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
    const clients = new Set();

    attachGatewayWsConnectionHandler({
      wss,
      clients: clients as never,
      preauthConnectionBudget: { release: vi.fn() } as never,
      port: 19001,
      canvasHostEnabled: false,
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
          nodeRegistry: { unregister: vi.fn() },
          nodeUnsubscribeAll: vi.fn(),
        }) as never,
    });

    const onConnection = listeners.get("connection");
    expect(onConnection).toBeTypeOf("function");
    onConnection?.(socket, upgradeReq);

    const passed = attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0] as {
      setClient: (client: unknown) => boolean;
    };
    socket.emit("close", 1001, Buffer.from("client left"));

    const registered = passed.setClient({
      socket,
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      connId: "late-client",
      usesSharedGatewayAuth: false,
    });

    expect(registered).toBe(false);
    expect(clients.size).toBe(0);
  });
});
