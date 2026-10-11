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
import {
  GatewayBrowserClient,
  type GatewayBrowserClientOptions,
  type GatewayHelloOk,
} from "./gateway.ts";

const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;

const nativeConnectAuth: NonNullable<GatewayBrowserClientOptions["nativeConnectAuth"]> = async ({
  nonce,
  signedAt,
}) => ({
  client: {
    id: "openclaw-ios",
    version: "test",
    mode: "ui",
    platform: "iOS",
  },
  scopes: ["operator.read", "operator.write"],
  auth: {},
  expectedHelloAuth: {
    method: "tailscale",
    recoveryScope: "tailscale-account-a",
  },
  device: {
    id: "native-device",
    publicKey: "synthetic-public-key",
    signature: "synthetic-signature",
    nonce,
    signedAt,
  },
});

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

function emitNativeHello(
  ws: MockWebSocket,
  id: string,
  auth: Partial<NonNullable<GatewayHelloOk["auth"]>>,
) {
  ws.emitMessage({
    type: "res",
    id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [], ...auth },
    },
  });
}

describe("GatewayBrowserClient handshake", () => {
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
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.minProtocol).toBe(MIN_CLIENT_PROTOCOL_VERSION);
    expect(connectFrame.params?.maxProtocol).toBe(PROTOCOL_VERSION);
    expect(connectFrame.params?.client.buildId).toBe("build-a");
    expect(connectFrame.params?.caps).toEqual([
      GATEWAY_CLIENT_CAPS.AGENT_KIND,
      GATEWAY_CLIENT_CAPS.APPROVALS,
      GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
      GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
      GATEWAY_CLIENT_CAPS.TERMINAL_SESSION_METADATA,
      GATEWAY_CLIENT_CAPS.TERMINAL_UPLOAD_PATH_STYLE,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
      GATEWAY_CLIENT_CAPS.CHAT_ONLY_ASSISTANT_TEXT,
      GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
      GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
      GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
      GATEWAY_CLIENT_CAPS.UI_COMMANDS,
      GATEWAY_CLIENT_CAPS.ULTRAFAST,
      GATEWAY_CLIENT_CAPS.USAGE_REFRESHING,
    ]);
    expect(connectFrame.params?.scopes).toEqual([...CONTROL_UI_OPERATOR_SCOPES]);
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

  describe("native personal-auth admission", () => {
    it.each([
      { method: "token", recoveryScope: "tailscale-account-a" },
      { method: "tailscale", recoveryScope: "tailscale-account-b" },
    ] as const)(
      "rejects a native hello with $method auth and $recoveryScope before publishing events or requests",
      async ({ method, recoveryScope }) => {
        const onHello = vi.fn();
        const onEvent = vi.fn();
        const onListenerEvent = vi.fn();
        const onRecoveryScopeChange = vi.fn();
        const onClose = vi.fn();
        client = new GatewayBrowserClient({
          url: "ws://127.0.0.1:18789",
          nativeConnectAuth,
          onHello,
          onEvent,
          onRecoveryScopeChange,
          onClose,
        });
        const { ws, connectFrame } = await startConnect(client);
        const removeListener = client.addEventListener(onListenerEvent);
        const earlyRequest = client.request("gateway.info").catch(() => undefined);
        ws.emitMessage({ type: "event", event: "chat", payload: { state: "delta" }, seq: 1 });
        expect(ws.sent.map((frame) => JSON.parse(frame).method)).toEqual(["connect"]);
        expect(onEvent).not.toHaveBeenCalled();
        expect(onListenerEvent).not.toHaveBeenCalled();

        emitNativeHello(ws, connectFrame.id, { method, recoveryScope });
        await Promise.resolve();
        await Promise.resolve();

        expect(onHello).not.toHaveBeenCalled();
        expect(onRecoveryScopeChange).not.toHaveBeenCalled();
        expect(onEvent).not.toHaveBeenCalled();
        expect(onListenerEvent).not.toHaveBeenCalled();
        expect(client.recoveryScope).toBe("");
        expect(client.recoveryScopeReady).toBe(false);
        expect(client.connected).toBe(false);
        expect(ws.lastClose).toEqual({ code: 4008, reason: "connect failed" });
        ws.emitClose(4008, "connect failed");
        await earlyRequest;
        removeListener();
        expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ willRetry: false }));
      },
    );

    it("admits a native Tailscale hello only for its expected personal recovery scope", async () => {
      const onHello = vi.fn();
      const onEvent = vi.fn();
      const onListenerEvent = vi.fn();
      client = new GatewayBrowserClient({
        url: "ws://127.0.0.1:18789",
        nativeConnectAuth,
        onHello,
        onEvent,
      });
      const { ws, connectFrame } = await startConnect(client);
      const removeListener = client.addEventListener(onListenerEvent);
      const earlyRequest = client.request("gateway.info").catch(() => undefined);
      ws.emitMessage({ type: "event", event: "chat", payload: { state: "delta" }, seq: 1 });
      expect(ws.sent.map((frame) => JSON.parse(frame).method)).toEqual(["connect"]);
      expect(onEvent).not.toHaveBeenCalled();
      expect(onListenerEvent).not.toHaveBeenCalled();

      emitNativeHello(ws, connectFrame.id, {
        method: "tailscale",
        recoveryScope: "tailscale-account-a",
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(onHello).toHaveBeenCalledOnce();
      expect(client.recoveryScope).toBe("tailscale-account-a");
      ws.emitMessage({ type: "event", event: "chat", payload: { state: "delta" }, seq: 2 });
      expect(onEvent).toHaveBeenCalledOnce();
      expect(onListenerEvent).toHaveBeenCalledOnce();

      const request = client.request("gateway.info");
      const requestFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
      expect(requestFrame.method).toBe("gateway.info");
      ws.emitMessage({ type: "res", id: requestFrame.id, ok: true, payload: { ready: true } });
      await expect(request).resolves.toEqual({ ready: true });
      removeListener();
      await earlyRequest;
    });
  });
});
