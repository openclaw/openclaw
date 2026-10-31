import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { expect, it, vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { GatewayConnectionWork } from "../server-connection-work.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { attachGatewayConnection } from "./connection.js";
import {
  createGatewayWsTestLogger,
  createGatewayWsTestRequestContext,
} from "./ws-connection.test-helpers.js";
import type { GatewayWsClient } from "./ws-types.js";

it("publishes capabilities and retires a non-WebSocket transport before session cleanup", async () => {
  const clients = new GatewayClientRegistry();
  const connectionWork = new GatewayConnectionWork();
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close(code: number, reason: string) {
      socket.emit("close", code, Buffer.from(reason));
    },
    terminate() {
      socket.close(1006, "");
    },
  });
  const client: GatewayWsClient = {
    socket,
    connId: "transport-test",
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
    },
  };
  const releasePreauth = vi.fn();
  const context = {
    ...createGatewayWsTestRequestContext(),
    terminalSessions: { handleDisconnect: vi.fn() },
  };
  context.unsubscribeAllSessionEvents.mockImplementation(() => {
    expect(client.connectionSignal?.aborted).toBe(true);
  });
  const log = createGatewayWsTestLogger();
  attachGatewayConnection({
    socket,
    clients,
    connectionWork,
    releasePreauth,
    connectionKind: "gateway",
    bootId: "transport-test",
    request: { headers: { host: "127.0.0.1:19001" } } as IncomingMessage,
    ingressAttribution: {
      kind: "direct-local",
      clientIp: "127.0.0.1",
      rateLimit: { subject: { key: "127.0.0.1" }, resetOnSuccess: true },
    },
    addresses: { remoteAddr: "127.0.0.1" },
    pluginNodeCapabilities: [],
    originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
    prepareAuthenticatedReceive: () => ({ ok: true, value: vi.fn() }),
    getResolvedAuth: () => ({ mode: "token", token: "test-token", allowTailscale: false }),
    gatewayMethods: [],
    events: [],
    extraHandlers: {},
    refreshHealthSnapshot: vi.fn(),
    logGateway: log as never,
    logHealth: log as never,
    logWsControl: log as never,
    broadcast: vi.fn(),
    buildRequestContext: () => context as never,
    attachTransport: (lifecycle) => {
      client.connId = lifecycle.connId;
      expect(lifecycle.setClient(client)).toBe(true);
      expect(lifecycle.setClient({ ...client, connId: "competing" })).toBe(false);
    },
  });
  try {
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({
      event: "connect.challenge",
      payload: { capabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT] },
    });
    expect([...clients]).toEqual([client]);
    expect(client.connectionSignal?.aborted).toBe(false);
    socket.close(1000, "done");
    await connectionWork.drain();
    expect(clients.size).toBe(0);
    expect(releasePreauth).toHaveBeenCalledOnce();
    for (const cleanup of [
      context.unsubscribeAllSessionEvents,
      context.terminalSessions.handleDisconnect,
    ]) {
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(client.connId);
    }
  } finally {
    socket.terminate();
    await connectionWork.drain();
  }
});
