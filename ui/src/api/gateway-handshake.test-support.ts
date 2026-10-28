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

export function useSocketHarness() {
  const clients: GatewayBrowserClient[] = [];
  beforeEach(() => {
    useNodeFakeTimers();
    stubWindowGlobals();
    vi.stubGlobal("WebSocket", MockWebSocket);
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
  return (options: Partial<GatewayBrowserClientOptions> = {}) => {
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789", ...options });
    clients.push(client);
    return client;
  };
}

export function useHandshakeHarness(crypto: unknown = { randomUUID: () => "handshake-request" }) {
  const createClient = useSocketHarness();
  beforeEach(() => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage);
    stubWindowGlobals(storage);
    vi.stubGlobal("crypto", crypto);
  });
  return createClient;
}

export async function startConnect(client: GatewayBrowserClient, nonce = "handshake-challenge") {
  client.start();
  const ws = getLatestWebSocket();
  ws.emitOpen();
  ws.emitConnectChallenge({ nonce, ts: 1_800_000_000_000 });
  await vi.advanceTimersByTimeAsync(0);
  const connectFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as {
    id: string;
    method: string;
    params: ConnectParams;
  };
  return { ws, connectFrame };
}
