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
const identityKey = "openclaw-device-identity-v1";
const authKey = "openclaw.device.auth.v1:wss://gateway.example/work";

function expectNativeGrant(params: ConnectParams, auth: Record<string, string>) {
  expect(params.device?.id).toBe(deviceId);
  expect(params.scopes).toEqual(scopes);
  expect(params.auth).toEqual(auth);
}

function expectNoStoredCredentials(...storageKeys: string[]) {
  expect(storageKeys.map((key) => localStorage.getItem(key))).toEqual(storageKeys.map(() => null));
}

function store(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function challengeSocket(socket: RecordingSocket, nonce = "challenge-1", ts = signedAt) {
  socket.emitOpen();
  socket.emitMessage({ type: "event", event: "connect.challenge", payload: { nonce, ts } });
}

function deliverPort(port: MessagePort, source: unknown = null, origin = "", target = gatewayUrl) {
  window.dispatchEvent(
    Object.assign(new Event("message"), {
      data: JSON.stringify({ type: "openclaw.native-control-auth", gatewayUrl: target }),
      source,
      origin,
      ports: [port],
    }),
  );
}

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
  hello(id: string, deviceToken?: string) {
    this.emitMessage({
      type: "res",
      id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 3,
        auth: { role: "operator", scopes, ...(deviceToken ? { deviceToken } : {}) },
      },
    });
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

  function replyWith(authorize: (challenge: Challenge) => unknown = signedAuthorization) {
    return (message: string) => {
      bridge.onmessage?.({ data: JSON.stringify(authorize(JSON.parse(message))) });
    };
  }

  function refuse(error: string) {
    return replyWith(({ id }) => ({ id, error }));
  }

  function respondWith(authorize: (challenge: Challenge) => unknown) {
    bridge.postMessage.mockImplementation(replyWith(authorize));
  }

  function authorizeWith(token: string) {
    respondWith((challenge) => signedAuthorization(challenge, token));
  }

  function nativePort() {
    const channel = new MessageChannel();
    ports.push(channel.port1, channel.port2);
    const send = vi.spyOn(channel.port2, "postMessage");
    return { channel, send };
  }

  function currentSocket(nonce = "challenge-1", ts = signedAt) {
    const socket = wsInstances.at(-1);
    if (!(socket instanceof RecordingSocket)) {
      throw new Error("missing socket");
    }
    challengeSocket(socket, nonce, ts);
    return socket;
  }

  async function expectRejected(socket: RecordingSocket) {
    await socket.closed.promise;
    socket.emitClose(4008, "native authorization unavailable");
    expect(socket.sent).toEqual([]);
    expect(localStorage.getItem(identityKey)).toBeNull();
  }

  async function stopWithoutRetry(socketCount: number) {
    gateway!.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(socketCount);
  }

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
    bridge = { onmessage: null, postMessage: vi.fn(replyWith()) };
    const host = Object.assign(new EventTarget(), {
      location,
      localStorage: storage,
      OpenClawNativeGatewayAuth: bridge,
      // Shipped legacy secrets must stay ignored even on bridge refusal/timeout.
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

  function createGateway(settings = makeUiSettings(gatewayUrl)) {
    const startup = resolveApplicationStartupSettings(settings, {
      pathname: window.location.pathname,
      search: "",
      hash: window.location.hash,
    });
    gateway = createApplicationGateway(startup.settings, "", "", {
      persistDefaultConnectionSettings: false,
      clientOptions: startup.nativeClient ?? undefined,
    });
    return startup;
  }
  function usePortTransport() {
    Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__");
    Object.assign(window, { OpenClawNativeGatewayAuth: undefined });
    window.location.hash = `nativeControlAuth=${encodeURIComponent(gatewayUrl)}`;
  }
  function connect(
    target = gatewayUrl,
    cachedToken = "obsolete-browser-secret",
    challenge = { nonce: "challenge-1", ts: signedAt },
  ) {
    createGateway(makeUiSettings(gatewayUrl, { token: cachedToken }));
    gateway!.connect({ gatewayUrl: target });
    return currentSocket(challenge.nonce, challenge.ts);
  }

  it.each(["before challenge", "after challenge"])(
    "uses the approved native identity on older WebViews when the port arrives %s",
    async (arrival) => {
      usePortTransport();
      const { channel, send } = nativePort();
      channel.port1.on("message", (message: string) => {
        channel.port1.postMessage(JSON.stringify(signedAuthorization(JSON.parse(message))));
      });
      const deliver = (source: unknown, origin: string, target = gatewayUrl) =>
        deliverPort(channel.port2, source, origin, target);
      if (arrival === "before challenge") {
        // Startup owns the listener, before the Gateway opens or sends a challenge.
        const startup = createGateway();
        expect(startup.nativeClient?.nativeConnectAuth).toBeTypeOf("function");
        deliver(null, "");
        gateway!.connect();
        currentSocket();
      } else {
        const socket = connect();
        await vi.advanceTimersByTimeAsync(0);
        expect(socket.sent).toEqual([]);
        expect(localStorage.getItem(identityKey)).toBeNull();
        // Page/iframe messages and a port for another route cannot select the transport.
        deliver(window, window.location.origin);
        deliver(null, "https://foreign.example");
        deliver(null, "", "wss://gateway.example/other/");
        await vi.advanceTimersByTimeAsync(0);
        expect(socket.sent).toEqual([]);
        expect(send).not.toHaveBeenCalled();
        deliver(null, "");
      }
      const socket = wsInstances.at(-1) as RecordingSocket;
      const frame = await socket.connect.promise;
      expectNativeGrant(frame.params, { deviceToken: "synthetic-native-grant" });
      expect(send).toHaveBeenCalledOnce();
      expect(localStorage.getItem(identityKey)).toBeNull();
      expect(bridge.postMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["legacy port", "native reply"] as const)(
    "retires a cancelled challenge before a late %s arrives",
    async (transport) => {
      let request: Challenge | undefined;
      if (transport === "legacy port") {
        usePortTransport();
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
        const { channel, send } = nativePort();
        deliverPort(channel.port2);
        await vi.advanceTimersByTimeAsync(0);
        expect(send).not.toHaveBeenCalled();
      } else {
        bridge.onmessage?.({ data: JSON.stringify(signedAuthorization(request!)) });
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(socket.sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(localStorage.getItem(identityKey)).toBeNull();
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
        const handler = { postMessage: async (challenge: Challenge) => authorize(challenge) };
        Object.assign(window, {
          OpenClawNativeGatewayAuth: undefined,
          webkit: { messageHandlers: { OpenClawNativeGatewayAuth: handler } },
        });
      } else if (transport === "Tauri") {
        bridge.postMessage.mockImplementation((message) =>
          Promise.resolve(authorize(JSON.parse(message))),
        );
      } else {
        respondWith(authorize);
      }
      const socket = connect();
      const frame = await Promise.race([
        socket.connect.promise,
        socket.closed.promise.then(() => {
          throw new Error("native method rejected before connect");
        }),
      ]);
      expectNativeGrant(frame.params, { [kind]: secret });
      expect(frame.params.client).toMatchObject(nativeClient);
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
      const signature = Buffer.from(device.signature, "base64url");
      expect(verify(null, Buffer.from(payload), keys.publicKey, signature)).toBe(true);
      expect(localStorage.getItem(identityKey)).toBeNull();
      socket.hello(frame.id, "synthetic-hello-grant");
      await vi.advanceTimersByTimeAsync(0);
      expectNoStoredCredentials(identityKey, authKey);
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
      respondWith((challenge) => {
        const reply = signedAuthorization(challenge);
        return { ...reply, result: { ...reply.result, auth: scenario.auth } };
      });
    } else if (scenario.kind === "unavailable") {
      if (scenario.failure === "missing bridge") {
        Object.assign(window, { OpenClawNativeGatewayAuth: undefined });
      } else if (scenario.failure === "subframe") {
        Object.assign(window, { top: {} });
      } else {
        respondWith((request) => signedAuthorization({ ...request, nonce: "unrelated-challenge" }));
      }
    } else if (scenario.kind === "challenge") {
      bridge.postMessage.mockImplementation(refuse("Invalid gateway challenge"));
    }
    const socket = connect(
      scenario.kind === "target" ? scenario.target : gatewayUrl,
      scenario.kind === "challenge" ? "" : undefined,
      scenario.kind === "challenge" ? scenario.challenge : undefined,
    );
    await expectRejected(socket);
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
    expect(localStorage.getItem(identityKey)).toBeNull();
  });

  it("obtains the current native grant again when the dashboard reconnects", async () => {
    const first = connect();
    await first.connect.promise;
    authorizeWith("rotated-native-grant");
    gateway!.connect();
    const second = currentSocket("challenge-2", signedAt + 1);
    const frame = await second.connect.promise;
    expect(frame.params.auth).toEqual({ deviceToken: "rotated-native-grant" });
    expect(frame.params.device).toMatchObject({ id: deviceId, nonce: "challenge-2" });
    expect(bridge.postMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["native refusal", "rejected promise", "silent bridge", "silent bridge stopped"])(
    "settles %s without browser credentials and cancels retries when stopped",
    async (failure) => {
      bridge.postMessage.mockImplementation(
        failure === "native refusal"
          ? refuse("Native grant unavailable")
          : () =>
              failure === "rejected promise"
                ? Promise.reject(new Error("Native connection ended"))
                : undefined,
      );
      const first = connect();
      if (failure.startsWith("silent bridge")) {
        // Stop at the authorization deadline, before the local close's retry fires.
        await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS / 2);
      }
      await expectRejected(first);
      expect(gateway!.snapshot.lastError).toBeTruthy();
      if (failure.startsWith("silent bridge")) {
        expect(gateway!.snapshot.lastError).toContain("did not authorize");
      }
      if (failure === "silent bridge stopped") {
        expect(wsInstances).toHaveLength(1);
        await stopWithoutRetry(1);
        return;
      }

      authorizeWith("reconnected-native-grant");
      await vi.advanceTimersByTimeAsync(800);
      expect(wsInstances).toHaveLength(2);
      const second = currentSocket("recovered-challenge", signedAt + 1);
      const frame = await second.connect.promise;
      expectNativeGrant(frame.params, { deviceToken: "reconnected-native-grant" });
      expect(frame.params.device).toMatchObject({
        id: deviceId,
        nonce: "recovered-challenge",
        signedAt: signedAt + 1,
      });
      expect(bridge.postMessage).toHaveBeenCalledTimes(2);
      second.hello(frame.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(gateway!.snapshot.phase).toBe("connected");
      expectNoStoredCredentials(identityKey, authKey);
      await stopWithoutRetry(2);
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
      store(identityKey, {
        version: 1,
        deviceId,
        publicKey: publicKeyBytes.toString("base64url"),
        privateKey: keys.privateKey
          .export({ format: "der", type: "pkcs8" })
          .subarray(-32)
          .toString("base64url"),
        createdAtMs: 1,
      });
      store(authKey, {
        version: 1,
        deviceId,
        tokens: {
          operator: { token: "ios-existing-grant", role: "operator", scopes, updatedAtMs: 1 },
        },
      });
      const socket = connect(gatewayUrl, "");
      const frame = await socket.connect.promise;
      expectNativeGrant(frame.params, { deviceToken: "ios-existing-grant" });
      expect(frame.params.client).toMatchObject({ id: "openclaw-ios", mode: "ui", deviceFamily });
      expect(bridge.postMessage).not.toHaveBeenCalled();
    },
  );
});
