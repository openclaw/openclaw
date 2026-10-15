// @vitest-environment node
import { createHash, generateKeyPairSync, sign, verify, webcrypto } from "node:crypto";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  buildDeviceAuthPayloadV3,
  type ConnectParams,
} from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { MockWebSocket, wsInstances } from "../api/gateway-socket.test-support.ts";
import { makeUiSettings } from "../test-helpers/settings-node.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";

const gatewayUrl = "wss://gateway.example/work/";
const scopes = ["operator.read", "operator.write"];
const nativeClient = {
  id: "openclaw-android",
  version: "test",
  mode: "ui",
  platform: "android",
  deviceFamily: "Android",
  instanceId: "native-installation",
} as const;
const keys = generateKeyPairSync("ed25519");
const publicKeyBytes = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const deviceId = createHash("sha256").update(publicKeyBytes).digest("hex");
const signedAt = 1_790_000_000_000;
type Challenge = { id: string; nonce: string; signedAt: number };

class RecordingSocket extends MockWebSocket {
  readonly connect = createDeferred<{ id: string; params: ConnectParams }>();
  readonly closed = createDeferred();
  override send(data: string) {
    super.send(data);
    const frame = JSON.parse(data);
    if (frame.method === "connect") {
      this.connect.resolve(frame);
    }
  }
  override close(code?: number, reason?: string) {
    super.close(code, reason);
    this.closed.resolve();
  }
}

function signedAuthorization(
  challenge: Challenge,
  token = "synthetic-native-grant",
  kind: "token" | "password" | "deviceToken" = "deviceToken",
) {
  const payload = buildDeviceAuthPayloadV3({
    deviceId,
    clientId: nativeClient.id,
    clientMode: nativeClient.mode,
    platform: nativeClient.platform,
    deviceFamily: nativeClient.deviceFamily,
    role: "operator",
    scopes,
    token: kind === "password" ? null : token,
    nonce: challenge.nonce,
    signedAtMs: challenge.signedAt,
  });
  return {
    id: challenge.id,
    result: {
      client: nativeClient,
      scopes,
      auth: { [kind]: token },
      device: {
        id: deviceId,
        publicKey: publicKeyBytes.toString("base64url"),
        signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64url"),
        signedAt: challenge.signedAt,
        nonce: challenge.nonce,
      },
    },
  };
}

describe("native authenticated Control UI", () => {
  let gateway: ReturnType<typeof createApplicationGateway> | undefined;
  const ports: MessagePort[] = [];
  let bridge: {
    onmessage: ((event: { data: string }) => void) | null;
    postMessage: ReturnType<typeof vi.fn<(message: string) => void | Promise<unknown>>>;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    wsInstances.length = 0;
    const storage = createStorageMock();
    const location = new URL("https://gateway.example/work/dashboard/main");
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("location", location);
    vi.stubGlobal("navigator", {
      platform: "Linux aarch64",
      userAgent: "WebView",
      language: "en-US",
    });
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("WebSocket", RecordingSocket);
    bridge = {
      onmessage: null,
      postMessage: vi.fn((message: string) => {
        bridge.onmessage?.({ data: JSON.stringify(signedAuthorization(JSON.parse(message))) });
      }),
    };
    const host = Object.assign(new EventTarget(), {
      location,
      localStorage: storage,
      OpenClawNativeGatewayAuth: bridge,
      // Updated native apps retain these shipped bootstrap fields for older UIs.
      // Current UI must ignore them even when the native bridge refuses or times out.
      __OPENCLAW_NATIVE_CONTROL_AUTH__: {
        gatewayUrl,
        token: "legacy-bootstrap-token",
        password: "legacy-bootstrap-password",
        nativeConnectAuth: true,
      },
    });
    Object.assign(host, { top: host });
    vi.stubGlobal("window", host);
  });

  afterEach(() => {
    gateway?.stop();
    gateway = undefined;
    window.dispatchEvent(new Event("pagehide"));
    for (const port of ports.splice(0)) {
      port.close();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    wsInstances.length = 0;
  });

  function connect(
    target = gatewayUrl,
    cachedToken = "obsolete-browser-secret",
    challenge = { nonce: "challenge-1", ts: signedAt },
  ) {
    const startup = resolveApplicationStartupSettings(
      makeUiSettings(gatewayUrl, { token: cachedToken }),
      { pathname: "/work/dashboard/main", search: "", hash: window.location.hash },
    );
    gateway = createApplicationGateway(startup.settings, "", "", undefined, {
      persistDefaultConnectionSettings: false,
      clientOptions: startup.nativeClient ?? undefined,
    });
    gateway.connect({ gatewayUrl: target });
    const socket = wsInstances.at(-1);
    if (!(socket instanceof RecordingSocket)) {
      throw new Error("missing socket");
    }
    socket.emitOpen();
    socket.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: challenge,
    });
    return socket;
  }

  it.each(["before challenge", "after challenge"])(
    "uses the approved native identity on older WebViews when the port arrives %s",
    async (arrival) => {
      Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__");
      Object.assign(window, { OpenClawNativeGatewayAuth: undefined });
      window.location.hash = `nativeControlAuth=${encodeURIComponent(gatewayUrl)}`;
      const channel = new MessageChannel();
      ports.push(channel.port1, channel.port2);
      const sendToNative = vi.spyOn(channel.port2, "postMessage");
      channel.port1.on("message", (message: string) => {
        channel.port1.postMessage(JSON.stringify(signedAuthorization(JSON.parse(message))));
      });
      const deliver = (source: unknown, origin: string, target = gatewayUrl) => {
        window.dispatchEvent(
          Object.assign(new Event("message"), {
            data: JSON.stringify({ type: "openclaw.native-control-auth", gatewayUrl: target }),
            source,
            origin,
            ports: [channel.port2],
          }),
        );
      };
      if (arrival === "before challenge") {
        // Startup owns the listener, before the Gateway opens or sends a challenge.
        const startup = resolveApplicationStartupSettings(makeUiSettings(gatewayUrl), {
          pathname: window.location.pathname,
          search: "",
          hash: window.location.hash,
        });
        expect(startup.nativeClient?.nativeConnectAuth).toBeTypeOf("function");
        gateway = createApplicationGateway(startup.settings, "", "", undefined, {
          persistDefaultConnectionSettings: false,
          clientOptions: startup.nativeClient ?? undefined,
        });
        deliver(null, "");
        gateway.connect();
        const socket = wsInstances.at(-1) as RecordingSocket;
        socket.emitOpen();
        socket.emitMessage({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "challenge-1", ts: signedAt },
        });
      } else {
        const socket = connect();
        await vi.advanceTimersByTimeAsync(0);
        expect(socket.sent).toEqual([]);
        expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
        // Page/iframe messages and a port for another route cannot select the transport.
        deliver(window, window.location.origin);
        deliver(null, "https://foreign.example");
        deliver(null, "", "wss://gateway.example/other/");
        await vi.advanceTimersByTimeAsync(0);
        expect(socket.sent).toEqual([]);
        expect(sendToNative).not.toHaveBeenCalled();
        deliver(null, "");
      }
      const socket = wsInstances.at(-1) as RecordingSocket;
      const frame = await socket.connect.promise;
      expect(frame.params.device?.id).toBe(deviceId);
      expect(frame.params.scopes).toEqual(scopes);
      expect(frame.params.auth).toEqual({ deviceToken: "synthetic-native-grant" });
      expect(sendToNative).toHaveBeenCalledOnce();
      expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
      expect(bridge.postMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["legacy port", "native reply"] as const)(
    "retires a cancelled challenge before a late %s arrives",
    async (transport) => {
      let request: Challenge | undefined;
      if (transport === "legacy port") {
        Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__");
        Object.assign(window, { OpenClawNativeGatewayAuth: undefined });
        window.location.hash = `nativeControlAuth=${encodeURIComponent(gatewayUrl)}`;
      } else {
        bridge.postMessage.mockImplementation((message) => {
          request = JSON.parse(message);
        });
      }
      const socket = connect();
      if (transport === "native reply") {
        expect(request).toBeDefined();
      }
      gateway!.stop();
      if (transport === "legacy port") {
        const channel = new MessageChannel();
        ports.push(channel.port1, channel.port2);
        const sendToNative = vi.spyOn(channel.port2, "postMessage");
        window.dispatchEvent(
          Object.assign(new Event("message"), {
            data: JSON.stringify({ type: "openclaw.native-control-auth", gatewayUrl }),
            source: null,
            origin: "",
            ports: [channel.port2],
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(sendToNative).not.toHaveBeenCalled();
      } else {
        bridge.onmessage?.({ data: JSON.stringify(signedAuthorization(request!)) });
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(socket.sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
    },
  );

  it.each([
    ["Android", "deviceToken"],
    ["WebKit", "deviceToken"],
    ["Tauri", "deviceToken"],
    ["Android", "token"],
    ["Android", "password"],
  ] as const)(
    "%s preserves the approved native %s grant and identity without browser credentials",
    async (transport, kind) => {
      const secret = kind === "deviceToken" ? "synthetic-native-grant" : "accepted-native-secret";
      const authorize = (challenge: Challenge) => signedAuthorization(challenge, secret, kind);
      if (transport === "WebKit") {
        Object.assign(window, {
          OpenClawNativeGatewayAuth: undefined,
          webkit: {
            messageHandlers: {
              OpenClawNativeGatewayAuth: {
                postMessage: async (challenge: Challenge) => authorize(challenge),
              },
            },
          },
        });
      } else if (transport === "Tauri") {
        bridge.postMessage.mockImplementation((message) =>
          Promise.resolve(authorize(JSON.parse(message))),
        );
      } else {
        bridge.postMessage.mockImplementation((message) => {
          bridge.onmessage?.({ data: JSON.stringify(authorize(JSON.parse(message))) });
        });
      }
      const socket = connect();
      const frame = await Promise.race([
        socket.connect.promise,
        socket.closed.promise.then(() => {
          throw new Error("native method rejected before connect");
        }),
      ]);
      expect(frame.params.device?.id).toBe(deviceId);
      expect(frame.params.client).toMatchObject(nativeClient);
      expect(frame.params.scopes).toEqual(scopes);
      expect(frame.params.auth).toEqual({ [kind]: secret });
      if (transport !== "WebKit") {
        expect(bridge.postMessage).toHaveBeenCalledOnce();
      }
      const device = frame.params.device!;
      const payload = buildDeviceAuthPayloadV3({
        deviceId: device.id,
        clientId: frame.params.client.id,
        clientMode: frame.params.client.mode,
        platform: frame.params.client.platform,
        deviceFamily: frame.params.client.deviceFamily,
        role: frame.params.role!,
        scopes: frame.params.scopes!,
        token: kind === "password" ? null : frame.params.auth?.[kind],
        nonce: device.nonce!,
        signedAtMs: device.signedAt,
      });
      expect(
        verify(
          null,
          Buffer.from(payload),
          keys.publicKey,
          Buffer.from(device.signature, "base64url"),
        ),
      ).toBe(true);
      expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
      socket.emitMessage({
        type: "res",
        id: frame.id,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 3,
          auth: { role: "operator", deviceToken: "synthetic-hello-grant", scopes },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
      expect(localStorage.getItem("openclaw.device.auth.v1:wss://gateway.example/work")).toBeNull();
    },
  );

  type Rejection =
    | { kind: "credential"; auth: Record<string, string> }
    | { kind: "target"; target: string }
    | { kind: "unavailable"; failure: "missing bridge" | "wrong challenge" | "subframe" }
    | { kind: "challenge"; challenge: { nonce: string; ts: number } };
  it.each<Rejection>([
    { kind: "credential", auth: { bootstrapToken: "not-a-reusable-native-grant" } },
    { kind: "credential", auth: { token: "shared", deviceToken: "ambiguous-second-method" } },
    { kind: "credential", auth: { token: "" } },
    { kind: "target", target: "wss://other.example/work/" },
    { kind: "target", target: "wss://gateway.example/other/" },
    { kind: "target", target: "wss://gateway.example/work/?tenant=other" },
    { kind: "unavailable", failure: "missing bridge" },
    { kind: "unavailable", failure: "wrong challenge" },
    { kind: "unavailable", failure: "subframe" },
    { kind: "challenge", challenge: { nonce: "invalid|challenge", ts: signedAt } },
    { kind: "challenge", challenge: { nonce: "challenge", ts: 0 } },
    { kind: "challenge", challenge: { nonce: "é".repeat(257), ts: signedAt } },
    { kind: "challenge", challenge: { nonce: "\u001c", ts: signedAt } },
    { kind: "challenge", challenge: { nonce: "\u0085", ts: signedAt } },
  ])("rejects invalid native authorization without browser fallback: %j", async (scenario) => {
    if (scenario.kind === "credential") {
      bridge.postMessage.mockImplementation((message) => {
        const reply = signedAuthorization(JSON.parse(message));
        bridge.onmessage?.({
          data: JSON.stringify({ ...reply, result: { ...reply.result, auth: scenario.auth } }),
        });
      });
    } else if (scenario.kind === "unavailable") {
      if (scenario.failure === "missing bridge") {
        Object.assign(window, { OpenClawNativeGatewayAuth: undefined });
      } else if (scenario.failure === "subframe") {
        Object.assign(window, { top: {} });
      } else {
        bridge.postMessage.mockImplementation((message) => {
          const request: Challenge = JSON.parse(message);
          bridge.onmessage?.({
            data: JSON.stringify(signedAuthorization({ ...request, nonce: "unrelated-challenge" })),
          });
        });
      }
    } else if (scenario.kind === "challenge") {
      bridge.postMessage.mockImplementation((message) => {
        bridge.onmessage?.({
          data: JSON.stringify({ id: JSON.parse(message).id, error: "Invalid gateway challenge" }),
        });
      });
    }
    const socket = connect(
      scenario.kind === "target" ? scenario.target : gatewayUrl,
      scenario.kind === "challenge" ? "" : undefined,
      scenario.kind === "challenge" ? scenario.challenge : undefined,
    );
    await socket.closed.promise;
    socket.emitClose(4008, "native authorization unavailable");
    if (scenario.kind === "credential") {
      expect(gateway!.snapshot.lastError).toContain("invalid Gateway credential");
    } else if (scenario.kind === "target") {
      expect(bridge.postMessage).not.toHaveBeenCalled();
      expect(gateway!.snapshot.lastError).toContain("different Gateway");
    } else {
      expect(gateway!.snapshot.lastError).toBeTruthy();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(1);
      if (scenario.kind === "challenge") {
        expect(bridge.postMessage).not.toHaveBeenCalled();
        expect(gateway!.snapshot.lastError).toContain("valid native authentication challenge");
        expect(vi.getTimerCount()).toBe(0);
      }
    }
    expect(socket.sent).toEqual([]);
    expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
  });

  it("obtains the current native grant again when the dashboard reconnects", async () => {
    const first = connect();
    await first.connect.promise;
    bridge.postMessage.mockImplementation((message) => {
      bridge.onmessage?.({
        data: JSON.stringify(signedAuthorization(JSON.parse(message), "rotated-native-grant")),
      });
    });
    gateway!.connect();
    const second = wsInstances.at(-1) as RecordingSocket;
    second.emitOpen();
    second.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "challenge-2", ts: signedAt + 1 },
    });
    const frame = await second.connect.promise;
    expect(frame.params.auth).toEqual({ deviceToken: "rotated-native-grant" });
    expect(frame.params.device?.id).toBe(deviceId);
    expect(frame.params.device?.nonce).toBe("challenge-2");
    expect(bridge.postMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["native refusal", "rejected promise", "silent bridge", "silent bridge stopped"])(
    "settles %s without browser credentials and cancels retries when stopped",
    async (failure) => {
      bridge.postMessage.mockImplementation((message) => {
        if (failure === "rejected promise") {
          return Promise.reject(new Error("Native connection ended"));
        }
        if (failure === "native refusal") {
          bridge.onmessage?.({
            data: JSON.stringify({ id: JSON.parse(message).id, error: "Native grant unavailable" }),
          });
        }
        return undefined;
      });
      const first = connect();
      if (failure.startsWith("silent bridge")) {
        await vi.advanceTimersByTimeAsync(
          DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS / (failure === "silent bridge stopped" ? 1 : 2),
        );
      }
      await first.closed.promise;
      first.emitClose(4008, "native authorization unavailable");
      expect(first.sent).toEqual([]);
      expect(gateway!.snapshot.lastError).toBeTruthy();
      if (failure.startsWith("silent bridge")) {
        expect(gateway!.snapshot.lastError).toContain("did not authorize");
      }
      expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
      if (failure === "silent bridge stopped") {
        gateway!.stop();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(wsInstances).toHaveLength(1);
        return;
      }

      bridge.postMessage.mockImplementation((message) => {
        bridge.onmessage?.({
          data: JSON.stringify(
            signedAuthorization(JSON.parse(message), "reconnected-native-grant"),
          ),
        });
      });
      await vi.advanceTimersByTimeAsync(800);
      expect(wsInstances).toHaveLength(2);
      const second = wsInstances.at(-1) as RecordingSocket;
      second.emitOpen();
      second.emitMessage({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "recovered-challenge", ts: signedAt + 1 },
      });
      const frame = await second.connect.promise;
      expect(frame.params.auth).toEqual({ deviceToken: "reconnected-native-grant" });
      expect(frame.params.device).toMatchObject({
        id: deviceId,
        nonce: "recovered-challenge",
        signedAt: signedAt + 1,
      });
      expect(frame.params.scopes).toEqual(scopes);
      expect(bridge.postMessage).toHaveBeenCalledTimes(2);
      second.emitMessage({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { type: "hello-ok", protocol: 3, auth: { role: "operator", scopes } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(gateway!.snapshot.phase).toBe("connected");
      expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
      expect(localStorage.getItem("openclaw.device.auth.v1:wss://gateway.example/work")).toBeNull();
      gateway!.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(2);
    },
  );

  it.each(["iPhone", "iPad"])(
    "preserves the shipped %s nonpersistent identity handoff",
    async (deviceFamily) => {
      // The existing iOS host seeds its nonpersistent WKWebView, rather than
      // exposing a signing bridge. Exercise that shipped input with real signing.
      Object.assign(window, {
        __OPENCLAW_NATIVE_CONTROL_AUTH__: {
          gatewayUrl,
          client: { ...nativeClient, id: "openclaw-ios", platform: "iOS", deviceFamily, scopes },
        },
      });
      localStorage.setItem(
        "openclaw-device-identity-v1",
        JSON.stringify({
          version: 1,
          deviceId,
          publicKey: publicKeyBytes.toString("base64url"),
          privateKey: keys.privateKey
            .export({ format: "der", type: "pkcs8" })
            .subarray(-32)
            .toString("base64url"),
          createdAtMs: 1,
        }),
      );
      localStorage.setItem(
        "openclaw.device.auth.v1:wss://gateway.example/work",
        JSON.stringify({
          version: 1,
          deviceId,
          tokens: {
            operator: { token: "ios-existing-grant", role: "operator", scopes, updatedAtMs: 1 },
          },
        }),
      );
      const socket = connect(gatewayUrl, "");
      const frame = await socket.connect.promise;
      expect(frame.params.device?.id).toBe(deviceId);
      expect(frame.params.client).toMatchObject({ id: "openclaw-ios", mode: "ui", deviceFamily });
      expect(frame.params.scopes).toEqual(scopes);
      expect(frame.params.auth).toEqual({ deviceToken: "ios-existing-grant" });
      expect(bridge.postMessage).not.toHaveBeenCalled();
    },
  );
});
