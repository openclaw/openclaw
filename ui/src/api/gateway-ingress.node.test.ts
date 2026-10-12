/** @vitest-environment node */
import { webcrypto } from "node:crypto";
import type { ConnectParams } from "@openclaw/gateway-client/browser";
import { afterEach, expect, it, vi } from "vitest";
import * as nodes from "../lib/nodes/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { expectSignedPayloadFields } from "./gateway-signature.test-support.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "./gateway.ts";

const gatewayUrl = "ws://127.0.0.1:18789";
let client: GatewayBrowserClient | undefined;

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

afterEach(() => {
  client?.stop();
  client = undefined;
  wsInstances.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("signs credential-free ingress connects and reconnects without reading or storing device tokens", async () => {
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
  nodes.storeDeviceAuthToken({
    deviceId: "device-1",
    role: "operator",
    gatewayUrl,
    token: "previous-browser-token",
    scopes: ["operator.admin"],
  });
  const loadToken = vi.spyOn(nodes, "loadDeviceAuthToken");
  const storeToken = vi.spyOn(nodes, "storeDeviceAuthToken");
  vi.spyOn(nodes, "loadOrCreateDeviceIdentity").mockResolvedValue({
    deviceId: "device-1",
    publicKey: "synthetic-public-key",
    privateKey: "synthetic-private-key",
  });
  const sign = vi.spyOn(nodes, "signDevicePayload").mockResolvedValue("synthetic-signature");
  const onReconnectScheduled = vi.fn<(delayMs: number) => void>();
  const nativeConnectAuth = vi.fn();
  client = new GatewayBrowserClient({
    url: gatewayUrl,
    token: "synthetic-shared-token",
    password: "synthetic-password",
    bootstrapToken: "synthetic-bootstrap-token",
    nativeConnectAuth,
    onReconnectScheduled,
  });
  client.start();
  const first = await connect();
  expect(first.frame.params.auth).toBeUndefined();
  expect(first.frame.params.role).toBe("operator");
  expect(first.frame.params.scopes).toEqual([]);
  expect(first.frame.params.device).toMatchObject({
    id: "device-1",
    signature: "synthetic-signature",
  });
  expectSignedPayloadFields(sign.mock.calls[0]?.[1], {
    scopes: [],
    token: "",
    nonce: "synthetic-nonce",
    signedAtMs: 1_800_000_000_000,
  });
  expect(loadToken).not.toHaveBeenCalled();
  expect(nativeConnectAuth).not.toHaveBeenCalled();
  first.ws.emitMessage({
    type: "res",
    id: first.frame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: {
        role: "operator",
        // Even an unexpected token must not create reusable ingress credentials.
        deviceToken: "ignored-ingress-token",
        scopes: ["operator.admin"],
        recoveryScope: "grant-principal-recovery",
      },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(client.connected).toBe(true);
  expect(client.scopeUpgradeReady).toBe(false);
  expect(client.recoveryScope).toBe("grant-principal-recovery");
  expect(storeToken).not.toHaveBeenCalled();

  first.ws.emitClose(1006, "transport interrupted");
  expect(onReconnectScheduled).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(onReconnectScheduled.mock.calls[0]![0]);
  const next = await connect();
  expect(next.frame.params.auth).toBeUndefined();
  expect(next.frame.params.scopes).toEqual([]);
  expect(next.frame.params.device?.id).toBe("device-1");
  expect(loadToken).not.toHaveBeenCalled();
  expect(storeToken).not.toHaveBeenCalled();

  client.stop();
  client.start();
  const restarted = await connect();
  expect(restarted.frame.params.auth).toBeUndefined();
  expect(restarted.frame.params.device?.id).toBe("device-1");
  expect(loadToken).not.toHaveBeenCalled();
  expect(storeToken).not.toHaveBeenCalled();
});
