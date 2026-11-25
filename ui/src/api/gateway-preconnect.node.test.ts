/** @vitest-environment node */
import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as remoteIngress from "../app/remote-ingress.ts";
import * as nodes from "../lib/nodes/index.ts";
import { useHandshakeHarness } from "./gateway-handshake.test-support.ts";
import { getLatestWebSocket, MockWebSocket, wsInstances } from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "./gateway.ts";

useHandshakeHarness();
const url = "ws://127.0.0.1:18789";
let preconnect: NonNullable<ReturnType<typeof GatewayBrowserClient.preconnect>>;

beforeEach(() => {
  vi.spyOn(nodes, "loadOrCreateDeviceIdentity").mockResolvedValue({
    deviceId: "preconnect-device",
    privateKey: "unused-private-key",
    publicKey: "synthetic-public-key",
  });
  vi.spyOn(nodes, "signDevicePayload").mockResolvedValue("synthetic-signature");
  preconnect = GatewayBrowserClient.preconnect(url)!;
});

afterEach(() => preconnect.client.stop());

function challenge(nonce = "first-challenge") {
  const socket = getLatestWebSocket();
  socket.emitOpen();
  socket.emitConnectChallenge({ nonce, ts: 1_800_000_000_000 });
  return socket;
}

it("opens without auth work and adopts the canonical owner once on the same socket", async () => {
  const socket = challenge();
  socket.emitMessage({ type: "event", event: "sessions.changed", payload: {}, seq: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.sent).toEqual([]);
  expect(nodes.loadOrCreateDeviceIdentity).not.toHaveBeenCalled();
  expect(nodes.signDevicePayload).not.toHaveBeenCalled();

  const onHello = vi.fn();
  const onEvent = vi.fn();
  const client = preconnect.adopt({
    url,
    token: "canonical-token",
    instanceId: "owner",
    onHello,
    onEvent,
  });
  expect(client).toBe(preconnect.client);
  await vi.advanceTimersByTimeAsync(0);
  expect(wsInstances).toHaveLength(1);
  expect(socket.sent).toHaveLength(1);
  const connect = JSON.parse(socket.sent[0] ?? "{}");
  expect(connect).toMatchObject({
    method: "connect",
    params: {
      auth: { token: "canonical-token" },
      client: { instanceId: "owner" },
      device: { nonce: "first-challenge" },
    },
  });
  expect(nodes.loadOrCreateDeviceIdentity).toHaveBeenCalledOnce();
  expect(nodes.signDevicePayload).toHaveBeenCalledOnce();
  expect(onHello).not.toHaveBeenCalled();
  expect(onEvent).not.toHaveBeenCalled();
  socket.emitMessage({
    type: "res",
    id: connect.id,
    ok: true,
    payload: { type: "hello-ok", protocol: PROTOCOL_VERSION },
  });
  await vi.advanceTimersByTimeAsync(0);
  socket.emitMessage({ type: "event", event: "presence", payload: [], seq: 2 });
  expect(onHello).toHaveBeenCalledOnce();
  expect(onEvent).toHaveBeenCalledOnce();
  expect(preconnect.adopt({ url, token: "replacement-token" })).toBeNull();
  expect(nodes.signDevicePayload).toHaveBeenCalledOnce();
});

it.each(["stop", "different URL"])(
  "cannot authenticate after %s retires the preconnection",
  async (retirement) => {
    const socket = challenge();
    if (retirement === "stop") {
      preconnect.client.stop();
    }
    expect(
      preconnect.adopt({
        url: retirement === "stop" ? url : "ws://other.example",
        token: "canonical-token",
      }),
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent).toEqual([]);
    expect(socket.readyState).toBe(3);
    expect(nodes.loadOrCreateDeviceIdentity).not.toHaveBeenCalled();
    expect(nodes.signDevicePayload).not.toHaveBeenCalled();
  },
);

it("retains protocol retry and signs only the replacement socket's challenge", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const retired = challenge();
  await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
  expect(retired.lastClose?.reason).toBe("connect timeout");
  await vi.advanceTimersByTimeAsync(800);
  const replacement = challenge("replacement-challenge");
  expect(wsInstances).toHaveLength(2);
  expect(preconnect.adopt({ url, token: "canonical-token" })).toBe(preconnect.client);
  await vi.advanceTimersByTimeAsync(0);
  expect(retired.sent).toEqual([]);
  expect(replacement.sent).toHaveLength(1);
  expect(JSON.parse(replacement.sent[0] ?? "{}")).toMatchObject({
    params: { device: { nonce: "replacement-challenge" } },
  });
  expect(nodes.loadOrCreateDeviceIdentity).toHaveBeenCalledOnce();
  expect(nodes.signDevicePayload).toHaveBeenCalledOnce();
});

it("retires a constructor failure so the application can create its ordinary client", async () => {
  preconnect.client.stop();
  vi.stubGlobal("WebSocket", function BrokenWebSocket() {
    throw new Error("synthetic socket construction failure");
  });
  preconnect = GatewayBrowserClient.preconnect(url)!;
  expect(preconnect.adopt({ url, token: "canonical-token" })).toBeNull();
  vi.stubGlobal("WebSocket", MockWebSocket);
  const onClose = vi.fn();
  const fallback = new GatewayBrowserClient({ url, token: "canonical-token", onClose });
  try {
    fallback.start();
    const socket = challenge();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent).toHaveLength(1);
    expect(nodes.signDevicePayload).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    fallback.stop();
  }
});

it("leaves remote ingress with its ordinary admission owner", () => {
  preconnect.client.stop();
  vi.spyOn(remoteIngress, "isRemoteControlUiIngress").mockReturnValue(true);
  expect(GatewayBrowserClient.preconnect(url)).toBeUndefined();
  expect(wsInstances).toHaveLength(1);
  expect(nodes.loadOrCreateDeviceIdentity).not.toHaveBeenCalled();
});
