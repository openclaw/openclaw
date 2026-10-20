import type { ConnectParams } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient, type GatewayBrowserClientOptions } from "./gateway.ts";

export function useHandshakeHarness(crypto: unknown = { randomUUID: () => "handshake-request" }) {
  const clients: GatewayBrowserClient[] = [];
  beforeEach(() => {
    useNodeFakeTimers();
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage);
    stubWindowGlobals(storage);
    vi.stubGlobal("WebSocket", MockWebSocket);
    // Most handshake tests need IDs, not device-proof crypto.
    vi.stubGlobal("crypto", crypto);
    wsInstances.length = 0;
  });
  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  return (options: GatewayBrowserClientOptions = { url: "ws://127.0.0.1:18789" }) => {
    const client = new GatewayBrowserClient(options);
    clients.push(client);
    return client;
  };
}

export async function startConnect(client: GatewayBrowserClient, nonce = "handshake-challenge") {
  client.start();
  const ws = getLatestWebSocket();
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce, ts: 1_800_000_000_000 },
  });
  await vi.advanceTimersByTimeAsync(0);
  const connectFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as {
    id: string;
    method: string;
    params: ConnectParams;
  };
  return { ws, connectFrame };
}
