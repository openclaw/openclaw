/** @vitest-environment node */
import { webcrypto } from "node:crypto";
import type { ConnectParams } from "@openclaw/gateway-client/browser";
import { afterEach, expect, it, vi } from "vitest";
import * as nodes from "../lib/nodes/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient, type GatewayBrowserClientOptions } from "./gateway.ts";

const gatewayUrl = "ws://127.0.0.1:18789";
const clients: GatewayBrowserClient[] = [];

function createClient(options: Partial<GatewayBrowserClientOptions> = {}) {
  const client = new GatewayBrowserClient({ url: gatewayUrl, ...options });
  clients.push(client);
  client.start();
  return client;
}

async function connect() {
  const ws = getLatestWebSocket();
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "synthetic-nonce", ts: 1_800_000_000_000 },
  });
  await vi.advanceTimersByTimeAsync(0);
  const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string; params: ConnectParams };
  return { ws, frame };
}

async function rejectToken(ws: MockWebSocket, id: string) {
  ws.emitMessage({
    type: "res",
    id,
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "unauthorized",
      details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(ws.readyState).toBe(3);
  ws.emitClose(4008, "connect failed");
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.stop();
  }
  wsInstances.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("connects embedded browsers without credentials, reuses hello tokens, and retries a rejected token once", async () => {
  useNodeFakeTimers();
  const storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("crypto", webcrypto);
  stubWindowGlobals(storage);
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("document", {
    documentElement: {
      getAttribute: (name: string) => (name === "data-openclaw-remote-ingress" ? "true" : null),
    },
  });
  vi.spyOn(nodes, "loadOrCreateDeviceIdentity").mockResolvedValue({
    deviceId: "device-1",
    publicKey: "synthetic-public-key",
    privateKey: "synthetic-private-key",
  });
  vi.spyOn(nodes, "signDevicePayload").mockResolvedValue("synthetic-signature");
  const firstClient = createClient({
    token: "synthetic-shared-token",
    password: "synthetic-password",
    bootstrapToken: "synthetic-bootstrap-token",
  });
  const first = await connect();
  expect(first.frame.params.auth).toBeUndefined();
  expect(first.frame.params.role).toBe("operator");
  expect(first.frame.params.scopes).toEqual([]);
  expect(first.frame.params.device).toMatchObject({
    id: "device-1",
    signature: "synthetic-signature",
  });
  first.ws.emitMessage({
    type: "res",
    id: first.frame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: {
        role: "operator",
        deviceToken: "embedded-device-token",
        scopes: ["operator.read", "operator.write"],
      },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  const storedToken = () =>
    nodes.loadDeviceAuthToken({ deviceId: "device-1", role: "operator", gatewayUrl });
  expect(storedToken()?.token).toBe("embedded-device-token");
  firstClient.stop();

  const onReconnectScheduled = vi.fn<(delayMs: number) => void>();
  createClient({ onReconnectScheduled });
  const next = await connect();
  expect(next.frame.params.auth).toEqual({ deviceToken: "embedded-device-token" });
  expect(next.frame.params.scopes).toEqual([]);
  await rejectToken(next.ws, next.frame.id);
  expect(onReconnectScheduled).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(onReconnectScheduled.mock.calls[0]![0]);
  expect(wsInstances).toHaveLength(3);
  const retry = await connect();
  expect(retry.frame.params.auth).toBeUndefined();
  expect(retry.frame.params.device?.id).toBe("device-1");
  expect(storedToken()).toBeNull();
  await rejectToken(retry.ws, retry.frame.id);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(onReconnectScheduled).toHaveBeenCalledOnce();
  expect(wsInstances).toHaveLength(3);
});
