/** @vitest-environment node */
import { webcrypto } from "node:crypto";
import {
  GATEWAY_CLIENT_CAPS,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ConnectParams,
} from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodes from "../lib/nodes/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "./gateway.ts";

const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;

async function startConnect(client: GatewayBrowserClient) {
  client.start();
  const ws = getLatestWebSocket();
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "handshake-challenge", ts: 1_800_000_000_000 },
  });
  await vi.advanceTimersByTimeAsync(0);
  const connectFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as {
    id: string;
    method: string;
    params: ConnectParams;
  };
  return { ws, connectFrame };
}

describe("GatewayBrowserClient shared-auth handshake", () => {
  let client: GatewayBrowserClient | undefined;

  beforeEach(() => {
    useNodeFakeTimers();
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage);
    stubWindowGlobals(storage);
    vi.stubGlobal("WebSocket", MockWebSocket);
    // Insecure browsers retain random IDs but have no device-proof crypto.
    vi.stubGlobal("crypto", { randomUUID: () => "handshake-request" });
    wsInstances.length = 0;
  });
  afterEach(() => {
    client?.stop();
    client = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("publishes negotiated scopes without a device token and retires them on disconnect", async () => {
    client = new GatewayBrowserClient({ url: "ws://scopes.example.test" });
    const { ws, connectFrame } = await startConnect(client);
    const auth = { role: "operator", scopes: ["operator.sessions.read"] };
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: PROTOCOL_VERSION,
        auth,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.auth).toEqual(auth);
    ws.emitClose(1006, "disconnected");
    expect(client.auth).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    const next = await startConnect(client);
    next.ws.emitMessage({
      type: "res",
      id: next.connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: PROTOCOL_VERSION,
        auth: { role: "operator", scopes: ["operator.admin"] },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.auth?.scopes).toEqual(["operator.admin"]);
    client.stop();
    expect(client.auth).toBeNull();
  });

  it.each(["rejected", "expired"])(
    "waits on the exact pairing request and stops reconnecting when %s",
    async (decision) => {
      vi.stubGlobal("crypto", webcrypto);
      const key = Buffer.alloc(32).toString("base64url");
      vi.spyOn(nodes, "loadOrCreateDeviceIdentity").mockResolvedValue({
        deviceId: "waiting-browser",
        privateKey: key,
        publicKey: key,
      });
      vi.spyOn(nodes, "signDevicePayload").mockResolvedValue("signature");
      const onClose = vi.fn();
      client = new GatewayBrowserClient({ url: "ws://pairing.example.test", onClose });
      const { ws, connectFrame } = await startConnect(client);
      const deviceId = connectFrame.params.device?.id;
      expect(deviceId).toBe("waiting-browser");
      ws.emitMessage({
        type: "res",
        id: connectFrame.id,
        ok: false,
        error: {
          code: "NOT_PAIRED",
          message: "pairing required",
          details: {
            code: "PAIRING_REQUIRED",
            requestId: "request-first",
            deviceId,
            waitForResolution: true,
            pauseReconnect: false,
          },
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ws.readyState).toBe(1);
      expect(wsInstances).toHaveLength(1);
      expect(onClose).toHaveBeenLastCalledWith(expect.objectContaining({ willRetry: true }));

      const resolve = (requestId: string, resolvedDeviceId = deviceId) =>
        ws.emitMessage({
          type: "event",
          event: "device.pair.resolved",
          payload: { requestId, deviceId: resolvedDeviceId, decision, ts: Date.now() },
        });
      resolve("another-request");
      resolve("request-first", "another-device");
      expect(ws.readyState).toBe(1);
      resolve("request-first");
      expect(ws.readyState).toBe(3);
      ws.emitClose(1008, `pairing ${decision}`);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wsInstances).toHaveLength(1);
      expect(client.needsWakeReconnect).toBe(false);
      expect(onClose).toHaveBeenLastCalledWith(
        expect.objectContaining({
          willRetry: false,
          error: expect.objectContaining({
            details: expect.objectContaining({
              code: decision === "rejected" ? "PAIRING_REJECTED" : "PAIRING_EXPIRED",
            }),
          }),
        }),
      );

      client.stop();
      await startConnect(client);
      expect(wsInstances).toHaveLength(2);
    },
  );

  it("requests full control ui operator scopes with explicit shared auth", async () => {
    client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      clientBuildId: "build-a",
      includeSessionMessageBodies: true,
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.minProtocol).toBe(MIN_CLIENT_PROTOCOL_VERSION);
    expect(connectFrame.params?.maxProtocol).toBe(PROTOCOL_VERSION);
    expect(connectFrame.params?.client.buildId).toBe("build-a");
    expect(connectFrame.params?.includeSessionMessageBodies).toBe(true);
    expect(connectFrame.params?.caps).toEqual([
      GATEWAY_CLIENT_CAPS.AGENT_KIND,
      GATEWAY_CLIENT_CAPS.APPROVALS,
      GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
      GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
      GATEWAY_CLIENT_CAPS.TERMINAL_SESSION_METADATA,
      GATEWAY_CLIENT_CAPS.TERMINAL_UPLOAD_PATH_STYLE,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
      GATEWAY_CLIENT_CAPS.CHAT_ONLY_ASSISTANT_TEXT,
      GATEWAY_CLIENT_CAPS.HELLO_HEALTH_ON_DEMAND,
      GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
      GATEWAY_CLIENT_CAPS.PRESENCE_DELTAS,
      GATEWAY_CLIENT_CAPS.SESSION_ROW_DELTAS,
      GATEWAY_CLIENT_CAPS.ROSTER_MESSAGE_BODIES_OPTIONAL,
      GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
      GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
      GATEWAY_CLIENT_CAPS.MODEL_WAIT_STATUS,
      GATEWAY_CLIENT_CAPS.UI_COMMANDS,
      GATEWAY_CLIENT_CAPS.ULTRAFAST,
      GATEWAY_CLIENT_CAPS.USAGE_REFRESHING,
    ]);
    expect(connectFrame.params?.scopes).toEqual([...CONTROL_UI_OPERATOR_SCOPES]);
  });

  it("leaves the native-auth capability list unchanged", async () => {
    client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      includeSessionMessageBodies: true,
      nativeConnectAuth: async ({ nonce, signedAt }) => ({
        client: { id: "openclaw-macos", mode: "ui", platform: "darwin", version: "test" },
        scopes: ["operator.read"],
        auth: { deviceToken: "native-device-token" },
        device: { id: "native-device", publicKey: "test", signature: "test", nonce, signedAt },
      }),
    });
    const { connectFrame } = await startConnect(client);
    expect(connectFrame.params.caps).not.toContain(GATEWAY_CLIENT_CAPS.SESSION_ROW_DELTAS);
    expect(connectFrame.params.caps).not.toContain(
      GATEWAY_CLIENT_CAPS.ROSTER_MESSAGE_BODIES_OPTIONAL,
    );
    expect(connectFrame.params).not.toHaveProperty("includeSessionMessageBodies");
    expect(connectFrame.params.client.id).toBe("openclaw-macos");
    expect(connectFrame.params.auth).toEqual({ deviceToken: "native-device-token" });
  });

  it.each([
    { retryAfterMs: 500, draw: 0.25, delayMs: 525 },
    { retryAfterMs: 500, draw: 0.75, delayMs: 575 },
    { retryAfterMs: 90_000, draw: 0.5, delayMs: 2_200 },
  ])("spreads bounded startup retries across tabs: %j", async ({ retryAfterMs, draw, delayMs }) => {
    vi.spyOn(Math, "random").mockReturnValue(draw);
    const onClose = vi.fn();
    const onReconnectScheduled = vi.fn();
    client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onClose,
      onReconnectScheduled,
    });
    const { ws, connectFrame } = await startConnect(client);
    const error = {
      code: "UNAVAILABLE",
      message: "gateway starting; retry shortly",
      details: { reason: "startup-sidecars" },
      retryable: true,
      retryAfterMs,
    };
    ws.emitMessage({ type: "res", id: connectFrame.id, ok: false, error });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.lastClose).toEqual({ code: 4013, reason: "gateway starting" });
    ws.emitClose(4013, "gateway starting");
    expect(onClose).toHaveBeenCalledWith({
      code: 4013,
      reason: "gateway starting",
      error,
      willRetry: true,
    });
    expect(onReconnectScheduled).toHaveBeenCalledExactlyOnceWith(delayMs);
    expect(wsInstances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(wsInstances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(wsInstances).toHaveLength(2);
  });
});
