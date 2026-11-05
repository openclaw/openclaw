/** @vitest-environment node */
import { webcrypto } from "node:crypto";
import {
  GATEWAY_CLIENT_CAPS,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { NativeGatewayAuthorization } from "../app/native-gateway-auth.ts";
import * as nodes from "../lib/nodes/index.ts";
import { startConnect, useHandshakeHarness } from "./gateway-handshake.test-support.ts";
import { getLatestWebSocket, wsInstances } from "./gateway-socket.test-support.ts";
import type { GatewayBrowserClient } from "./gateway.ts";

const createClient = useHandshakeHarness();

const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;

async function acceptConnect(
  { ws, connectFrame }: Awaited<ReturnType<typeof startConnect>>,
  auth: { role: string; scopes: string[]; method?: string; recoveryScope?: string },
  gatewayId?: string,
) {
  ws.emitMessage({
    type: "res",
    id: connectFrame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      auth,
      ...(gatewayId ? { server: { bootId: gatewayId } } : {}),
    },
  });
  await vi.advanceTimersByTimeAsync(0);
}

describe("GatewayBrowserClient shared-auth handshake", () => {
  let client: GatewayBrowserClient;

  it.each([
    { code: "PROTOCOL_MISMATCH" },
    { minProtocol: PROTOCOL_VERSION + 1, maxProtocol: PROTOCOL_VERSION + 2 },
    { minProtocol: 1, maxProtocol: MIN_CLIENT_PROTOCOL_VERSION - 1 },
    { expectedProtocol: PROTOCOL_VERSION + 1 },
  ])("does not auto-reconnect on an incompatible protocol: %j", async (details) => {
    const { ws: ws1, connectFrame: connect } = await startConnect(
      createClient({ token: "shared-auth-token" }),
    );

    ws1.emitMessage({
      type: "res",
      id: connect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Versions differ",
        details,
      },
    });
    await vi.waitFor(() => expect(ws1.readyState).toBe(3), { interval: 1, timeout: 50 });
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);
  });

  it("releases cached view work after connect is sent, before hello", async () => {
    client = createClient({ url: "ws://scopes.example.test" });
    client.start();
    const ws = getLatestWebSocket();
    const dispatch = vi.fn(() => {
      expect(JSON.parse(ws.sent.at(-1) ?? "{}").method).toBe("connect");
      expect(client?.hello).toBeNull();
    });
    const dispatched = client.initialConnectSent.then(dispatch);
    ws.emitOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).not.toHaveBeenCalled();
    ws.emitConnectChallenge({ nonce: "handshake-challenge", ts: 1_800_000_000_000 });
    await dispatched;
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not strand cached view work when the connection stops before dispatch", async () => {
    client = createClient({ url: "ws://scopes.example.test" });
    client.start();
    const dispatch = vi.fn();
    void client.initialConnectSent.then(dispatch);
    client.stop();
    await client.initialConnectSent;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(getLatestWebSocket().sent).toEqual([]);
  });

  it("publishes negotiated scopes without a device token and retires them on disconnect", async () => {
    client = createClient({ url: "ws://scopes.example.test" });
    const { ws, connectFrame } = await startConnect(client);
    const auth = { role: "operator", scopes: ["operator.sessions.read"] };
    await acceptConnect({ ws, connectFrame }, auth);
    expect(client.auth).toEqual(auth);
    ws.emitClose(1006, "disconnected");
    expect(client.auth).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    const next = await startConnect(client);
    await acceptConnect(next, { role: "operator", scopes: ["operator.admin"] });
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
      client = createClient({ url: "ws://pairing.example.test", onClose });
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
      expect(client.needsReachabilityReconnect).toBe(false);
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
    client = createClient({
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
      GATEWAY_CLIENT_CAPS.CHAT_QUEUE_STATUS,
      GATEWAY_CLIENT_CAPS.HELLO_HEALTH_ON_DEMAND,
      GATEWAY_CLIENT_CAPS.HEALTH_SUMMARY,
      GATEWAY_CLIENT_CAPS.HELLO_PRESENCE_SELF,
      GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
      GATEWAY_CLIENT_CAPS.PRESENCE_DELTAS,
      GATEWAY_CLIENT_CAPS.SESSION_ROW_DELTAS,
      GATEWAY_CLIENT_CAPS.SESSION_EVENT_FIELD_REFS,
      GATEWAY_CLIENT_CAPS.ROSTER_MESSAGE_BODIES_OPTIONAL,
      GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
      GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
      GATEWAY_CLIENT_CAPS.MODEL_WAIT_STATUS,
      GATEWAY_CLIENT_CAPS.UI_AGENT_GITHUB_SETTINGS,
      GATEWAY_CLIENT_CAPS.UI_COMMANDS,
      GATEWAY_CLIENT_CAPS.ULTRAFAST,
      GATEWAY_CLIENT_CAPS.USAGE_REFRESHING,
    ]);
    expect(connectFrame.params?.scopes).toEqual([...CONTROL_UI_OPERATOR_SCOPES]);
  });

  it.each(["ios", "android"])(
    "does not offer agent UI commands from native %s",
    async (platform) => {
      Object.assign(window, {
        __OPENCLAW_NATIVE_EMBED__: { platform, formFactor: "phone" },
      });
      const { connectFrame } = await startConnect(createClient({ token: "shared-auth-token" }));

      expect(connectFrame.params.caps).not.toContain(GATEWAY_CLIENT_CAPS.UI_COMMANDS);
      expect(connectFrame.params.caps).not.toContain(GATEWAY_CLIENT_CAPS.UI_AGENT_GITHUB_SETTINGS);
    },
  );

  it("leaves the native-auth capability list unchanged", async () => {
    client = createClient({
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
    expect(connectFrame.params.caps).not.toContain(GATEWAY_CLIENT_CAPS.SESSION_EVENT_FIELD_REFS);
    expect(connectFrame.params.caps).not.toContain(
      GATEWAY_CLIENT_CAPS.ROSTER_MESSAGE_BODIES_OPTIONAL,
    );
    expect(connectFrame.params).not.toHaveProperty("includeSessionMessageBodies");
    expect(connectFrame.params.client.id).toBe("openclaw-macos");
    expect(connectFrame.params.auth).toEqual({ deviceToken: "native-device-token" });
  });

  describe("native personal hello admission", () => {
    const recoveryScope = " tailscale-person-a ";
    const personalReply = (nonce: string, signedAt: number): NativeGatewayAuthorization => ({
      client: { id: "openclaw-ios", mode: "ui", platform: "iOS", version: "test" },
      scopes: ["operator.read"],
      auth: {},
      expectedHelloAuth: { method: "tailscale", recoveryScope },
      device: { id: "native-device", publicKey: "test", signature: "test", nonce, signedAt },
    });
    const personalAuth = {
      role: "operator",
      scopes: ["operator.read"],
      method: "tailscale",
      recoveryScope,
    };
    const event = { type: "event", event: "test.personal", payload: { value: "private" } };

    it.each([
      { method: "token", recoveryScope },
      { recoveryScope },
      { method: "tailscale", recoveryScope: "another-person" },
      { method: "tailscale", recoveryScope: recoveryScope.trim() },
      { method: "tailscale" },
    ])("rejects an unapproved hello before publishing native authority: %j", async (auth) => {
      const onHello = vi.fn();
      const onEvent = vi.fn();
      const onClose = vi.fn();
      client = createClient({
        nativeConnectAuth: async ({ nonce, signedAt }) => personalReply(nonce, signedAt),
        onHello,
        onEvent,
        onClose,
      });
      const { ws, connectFrame } = await startConnect(client);
      const listener = vi.fn();
      client.addEventListener(listener);
      expect(client.connected).toBe(false);
      ws.emitMessage(event);
      for (const method of ["health", "talk.catalog"]) {
        await expect(client.request(method)).rejects.toThrow("native Gateway hello");
      }
      await acceptConnect(
        { ws, connectFrame },
        { role: "operator", scopes: ["operator.read"], ...auth },
      );
      expect(client.connected).toBe(false);
      expect(client.auth).toBeNull();
      expect(client.hello).toBeNull();
      expect(client.recoveryScopeReady).toBe(false);
      expect(client.recoveryScope).toBe("");
      expect(onHello).not.toHaveBeenCalled();
      ws.emitMessage(event);
      expect(onEvent).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(ws.sent.map((frame) => JSON.parse(frame).method)).toEqual(["connect"]);
      ws.emitClose(4008, "connect failed");
      expect(onClose).toHaveBeenLastCalledWith(
        expect.objectContaining({
          willRetry: false,
          error: expect.objectContaining({ code: "UNAVAILABLE", retryable: false }),
        }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(1);
    });

    it.each([undefined, "cloned-gateway-boot"])(
      "rejects a matching personal identity from an unapproved Gateway boot: %s",
      async (bootId) => {
        const onHello = vi.fn();
        const onEvent = vi.fn();
        client = createClient({
          nativeConnectAuth: async ({ nonce, signedAt }) => ({
            ...personalReply(nonce, signedAt),
            expectedGatewayId: "primary-gateway-boot",
          }),
          onHello,
          onEvent,
        });
        const { ws, connectFrame } = await startConnect(client);
        const listener = vi.fn();
        client.addEventListener(listener);
        await acceptConnect({ ws, connectFrame }, personalAuth, bootId);
        ws.emitMessage(event);
        expect(client.connected).toBe(false);
        expect(client.hello).toBeNull();
        expect(client.auth).toBeNull();
        expect(client.recoveryScopeReady).toBe(false);
        expect(onHello).not.toHaveBeenCalled();
        expect(onEvent).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        await expect(client.request("health")).rejects.toThrow("native Gateway hello");
        expect(ws.sent.map((frame) => JSON.parse(frame).method)).toEqual(["connect"]);
      },
    );

    it("admits matching native authority and retires it before a reconnect close callback", async () => {
      const onHello = vi.fn();
      const onEvent = vi.fn();
      client = createClient({
        nativeConnectAuth: async ({ nonce, signedAt }) => personalReply(nonce, signedAt),
        onHello,
        onEvent,
      });
      const { ws, connectFrame } = await startConnect(client);
      const listener = vi.fn();
      client.addEventListener(listener);
      await acceptConnect({ ws, connectFrame }, personalAuth);
      expect(client.connected).toBe(true);
      expect(client.auth).toEqual(personalAuth);
      expect(client.recoveryScopeReady).toBe(true);
      expect(client.recoveryScope).toBe(recoveryScope);
      expect(onHello).toHaveBeenCalledOnce();
      ws.emitMessage(event);
      expect(onEvent).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledOnce();
      const result = client.request("health");
      const request = JSON.parse(ws.sent.at(-1)!);
      ws.emitMessage({ type: "res", id: request.id, ok: true, payload: { status: "ok" } });
      await expect(result).resolves.toEqual({ status: "ok" });
      const close = ws.close.bind(ws);
      vi.spyOn(ws, "close").mockImplementation((code, reason) => {
        expect(client.hello).toBeNull();
        expect(client.recoveryScopeReady).toBe(false);
        close(code, reason);
      });
      client.forceReconnect("personal reconnect");
      expect(client.connected).toBe(false);
      expect(client.auth).toBeNull();
      expect(client.hello).toBeNull();
      expect(client.recoveryScopeReady).toBe(false);
      await expect(client.request("talk.catalog")).rejects.toThrow("native Gateway hello");
      ws.emitMessage(event);
      expect(onEvent).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledOnce();
      expect(ws.sent.map((frame) => JSON.parse(frame).method)).toEqual(["connect", "health"]);
    });

    it("keeps a retired native reply from admitting or sending on the successor connection", async () => {
      const held = createDeferred<NativeGatewayAuthorization>();
      const nativeConnectAuth = vi.fn(
        async ({ nonce, signedAt }: { nonce: string; signedAt: number }) =>
          personalReply(nonce, signedAt),
      );
      nativeConnectAuth.mockImplementationOnce(() => held.promise);
      client = createClient({ nativeConnectAuth });
      const first = await startConnect(client, "retired-challenge");
      first.ws.emitClose(1006, "replaced");
      await vi.advanceTimersByTimeAsync(1_000);
      const next = await startConnect(client, "successor-challenge");
      held.resolve({
        ...personalReply("retired-challenge", 1_800_000_000_000),
        auth: { deviceToken: "retired-grant" },
        expectedHelloAuth: undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(first.ws.sent).toEqual([]);
      expect(client.connected).toBe(false);
      await expect(client.request("health")).rejects.toThrow("native Gateway hello");
      await acceptConnect(next, personalAuth);
      expect(client.connected).toBe(true);
      expect(client.auth).toEqual(personalAuth);
      expect(next.ws.sent.map((frame) => JSON.parse(frame).method)).toEqual(["connect"]);
    });
  });

  it.each([
    { retryAfterMs: 500, draw: 0.25, delayMs: 525 },
    { retryAfterMs: 500, draw: 0.75, delayMs: 575 },
    { retryAfterMs: 90_000, draw: 0.5, delayMs: 2_200 },
  ])("spreads bounded startup retries across tabs: %j", async ({ retryAfterMs, draw, delayMs }) => {
    vi.spyOn(Math, "random").mockReturnValue(draw);
    const onClose = vi.fn();
    const onReconnectScheduled = vi.fn();
    client = createClient({
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
    expect(client.needsWakeReconnect).toBe(false);
    expect(client.needsReachabilityReconnect).toBe(false);
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(wsInstances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(wsInstances).toHaveLength(2);
  });
});
