import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { captureEnv } from "../test-utils/env.js";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const clearDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const storeDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const logDebugMock = vi.hoisted(() => vi.fn());

type WsEvent = "open" | "message" | "close" | "error";
type WsEventHandlers = {
  open: () => void;
  message: (data: string | Buffer) => void;
  close: (code: number, reason: Buffer) => void;
  error: (err: unknown) => void;
};

class MockWebSocket {
  private openHandlers: WsEventHandlers["open"][] = [];
  private messageHandlers: WsEventHandlers["message"][] = [];
  private closeHandlers: WsEventHandlers["close"][] = [];
  private errorHandlers: WsEventHandlers["error"][] = [];
  readonly sent: string[] = [];
  closeCalls = 0;
  terminateCalls = 0;

  constructor(_url: string, _options?: unknown) {
    wsInstances.push(this);
  }

  on(event: "open", handler: WsEventHandlers["open"]): void;
  on(event: "message", handler: WsEventHandlers["message"]): void;
  on(event: "close", handler: WsEventHandlers["close"]): void;
  on(event: "error", handler: WsEventHandlers["error"]): void;
  on(event: WsEvent, handler: WsEventHandlers[WsEvent]): void {
    switch (event) {
      case "open":
        this.openHandlers.push(handler as WsEventHandlers["open"]);
        return;
      case "message":
        this.messageHandlers.push(handler as WsEventHandlers["message"]);
        return;
      case "close":
        this.closeHandlers.push(handler as WsEventHandlers["close"]);
        return;
      case "error":
        this.errorHandlers.push(handler as WsEventHandlers["error"]);
        return;
      default:
        return;
    }
  }

  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
    this.emitClose(code ?? 1000, reason ?? "");
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emitOpen(): void {
    for (const handler of this.openHandlers) {
      handler();
    }
  }

  emitMessage(data: string): void {
    for (const handler of this.messageHandlers) {
      handler(data);
    }
  }

  emitClose(code: number, reason: string): void {
    for (const handler of this.closeHandlers) {
      handler(code, Buffer.from(reason));
    }
  }
}

vi.mock("ws", () => ({
  WebSocket: MockWebSocket,
}));

vi.mock("../infra/device-auth-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-auth-store.js")>();
  return {
    ...actual,
    loadDeviceAuthToken: (...args: unknown[]) => loadDeviceAuthTokenMock(...args),
    storeDeviceAuthToken: (...args: unknown[]) => storeDeviceAuthTokenMock(...args),
    clearDeviceAuthToken: (...args: unknown[]) => clearDeviceAuthTokenMock(...args),
  };
});

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    logDebug: (...args: unknown[]) => logDebugMock(...args),
  };
});

const { GatewayClient } = await import("./client.js");
type GatewayClientInstance = InstanceType<typeof GatewayClient>;

function getLatestWs(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing mock websocket instance");
  }
  return ws;
}

function createClientWithIdentity(
  deviceId: string,
  onClose: (code: number, reason: string) => void,
) {
  const identity: DeviceIdentity = {
    deviceId,
    privateKeyPem: "private-key", // pragma: allowlist secret
    publicKeyPem: "public-key",
  };
  return new GatewayClient({
    url: "ws://127.0.0.1:18789",
    deviceIdentity: identity,
    onClose,
  });
}

function expectSecurityConnectError(
  onConnectError: ReturnType<typeof vi.fn>,
  params?: { expectTailscaleHint?: boolean },
) {
  expect(onConnectError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("SECURITY ERROR"),
    }),
  );
  const error = onConnectError.mock.calls[0]?.[0] as Error;
  expect(error.message).toContain("openclaw doctor --fix");
  if (params?.expectTailscaleHint) {
    expect(error.message).toContain("Tailscale Serve/Funnel");
  }
}

describe("GatewayClient security checks", () => {
  const envSnapshot = captureEnv(["OPENCLAW_ALLOW_INSECURE_PRIVATE_WS"]);

  beforeEach(() => {
    envSnapshot.restore();
    wsInstances.length = 0;
  });

  it("blocks ws:// to non-loopback addresses (CWE-319)", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://remote.example.com:18789",
      onConnectError,
    });

    client.start();

    expectSecurityConnectError(onConnectError, { expectTailscaleHint: true });
    expect(wsInstances.length).toBe(0); // No WebSocket created
    client.stop();
  });

  it("handles malformed URLs gracefully without crashing", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "not-a-valid-url",
      onConnectError,
    });

    // Should not throw
    expect(() => client.start()).not.toThrow();

    expectSecurityConnectError(onConnectError);
    expect(wsInstances.length).toBe(0); // No WebSocket created
    client.stop();
  });

  it("allows ws:// to loopback addresses", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1); // WebSocket created
    client.stop();
  });

  it("allows wss:// to any address", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "wss://remote.example.com:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1); // WebSocket created
    client.stop();
  });

  it("allows ws:// to private addresses only with OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1", () => {
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://192.168.1.100:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1);
    client.stop();
  });

  it("allows ws:// hostnames with OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1", () => {
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://openclaw-gateway.ai:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1);
    client.stop();
  });
});

describe("GatewayClient close handling", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    clearDeviceAuthTokenMock.mockClear();
    clearDeviceAuthTokenMock.mockImplementation(() => undefined);
    logDebugMock.mockClear();
  });

  it("clears stale token on device token mismatch close", () => {
    const onClose = vi.fn();
    const client = createClientWithIdentity("dev-1", onClose);

    client.start();
    getLatestWs().emitClose(
      1008,
      "unauthorized: DEVICE token mismatch (rotate/reissue device token)",
    );

    expect(clearDeviceAuthTokenMock).toHaveBeenCalledWith({ deviceId: "dev-1", role: "operator" });
    expect(logDebugMock).toHaveBeenCalledWith("cleared stale device-auth token for device dev-1");
    expect(onClose).toHaveBeenCalledWith(
      1008,
      "unauthorized: DEVICE token mismatch (rotate/reissue device token)",
    );
    client.stop();
  });

  it("does not break close flow when token clear throws", () => {
    clearDeviceAuthTokenMock.mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    const onClose = vi.fn();
    const client = createClientWithIdentity("dev-2", onClose);

    client.start();
    expect(() => {
      getLatestWs().emitClose(1008, "unauthorized: device token mismatch");
    }).not.toThrow();

    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("failed clearing stale device-auth token"),
    );
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: device token mismatch");
    client.stop();
  });

  it("does not clear auth state for non-mismatch close reasons", () => {
    const onClose = vi.fn();
    const client = createClientWithIdentity("dev-3", onClose);

    client.start();
    getLatestWs().emitClose(1008, "unauthorized: signature invalid");

    expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: signature invalid");
    client.stop();
  });

  it("force-terminates a lingering socket after stop", async () => {
    vi.useFakeTimers();
    try {
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
      });

      client.start();
      const ws = getLatestWs();

      client.stop();

      expect(ws.closeCalls).toBe(1);
      expect(ws.terminateCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(250);

      expect(ws.terminateCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear persisted device auth when explicit shared token is provided", () => {
    const onClose = vi.fn();
    const identity: DeviceIdentity = {
      deviceId: "dev-4",
      privateKeyPem: "private-key", // pragma: allowlist secret
      publicKeyPem: "public-key",
    };
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: identity,
      token: "shared-token",
      onClose,
    });

    client.start();
    getLatestWs().emitClose(1008, "unauthorized: device token mismatch");

    expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: device token mismatch");
    client.stop();
  });
});

describe("GatewayClient connect auth payload", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    loadDeviceAuthTokenMock.mockReset();
    storeDeviceAuthTokenMock.mockReset();
  });

  function connectFrameFrom(ws: MockWebSocket) {
    const raw = ws.sent.find((frame) => frame.includes('"method":"connect"'));
    if (!raw) {
      throw new Error("missing connect frame");
    }
    const parsed = JSON.parse(raw) as {
      params?: {
        auth?: {
          token?: string;
          bootstrapToken?: string;
          deviceToken?: string;
          password?: string;
        };
      };
    };
    return parsed.params?.auth ?? {};
  }

  function connectRequestFrom(ws: MockWebSocket) {
    const raw = ws.sent.find((frame) => frame.includes('"method":"connect"'));
    expect(raw).toBeTruthy();
    return JSON.parse(raw ?? "{}") as {
      id?: string;
      params?: {
        auth?: {
          token?: string;
          deviceToken?: string;
        };
      };
    };
  }

  function emitConnectChallenge(ws: MockWebSocket, nonce = "nonce-1") {
    ws.emitMessage(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce },
      }),
    );
  }

  function startClientAndConnect(params: { client: GatewayClientInstance; nonce?: string }) {
    params.client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws, params.nonce);
    return { ws, connect: connectRequestFrom(ws) };
  }

  function emitConnectFailure(
    ws: MockWebSocket,
    connectId: string | undefined,
    details: Record<string, unknown>,
  ) {
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connectId,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "unauthorized",
          details,
        },
      }),
    );
  }

  async function expectRetriedConnectAuth(params: {
    firstWs: MockWebSocket;
    connectId: string | undefined;
    failureDetails: Record<string, unknown>;
  }) {
    emitConnectFailure(params.firstWs, params.connectId, params.failureDetails);
    await vi.waitFor(() => expect(wsInstances.length).toBeGreaterThan(1), { timeout: 3_000 });
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws, "nonce-2");
    return connectFrameFrom(ws);
  }

  async function expectNoReconnectAfterConnectFailure(params: {
    client: GatewayClientInstance;
    firstWs: MockWebSocket;
    connectId: string | undefined;
    failureDetails: Record<string, unknown>;
  }) {
    vi.useFakeTimers();
    try {
      emitConnectFailure(params.firstWs, params.connectId, params.failureDetails);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(1);
    } finally {
      params.client.stop();
      vi.useRealTimers();
    }
  }

  it("uses explicit shared token and does not inject stored device token", () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "shared-token",
    });
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    client.stop();
  });

  it("uses explicit shared password and does not inject stored device token", () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      password: "shared-password", // pragma: allowlist secret
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      password: "shared-password", // pragma: allowlist secret
    });
    expect(connectFrameFrom(ws).token).toBeUndefined();
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    client.stop();
  });

  it("uses stored device token when shared token is not provided", () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "stored-device-token",
      deviceToken: "stored-device-token",
    });
    client.stop();
  });

  it("uses bootstrap token when no shared or device token is available", () => {
    loadDeviceAuthTokenMock.mockReturnValue(undefined);
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "bootstrap-token",
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      bootstrapToken: "bootstrap-token",
    });
    expect(connectFrameFrom(ws).token).toBeUndefined();
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    client.stop();
  });

  it("prefers explicit deviceToken over stored device token", () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceToken: "explicit-device-token",
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "explicit-device-token",
      deviceToken: "explicit-device-token",
    });
    client.stop();
  });

  it("retries with stored device token after shared-token mismatch on trusted endpoints", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    expect(firstConnect.params?.auth?.token).toBe("shared-token");
    expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

    const retriedAuth = await expectRetriedConnectAuth({
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    });
    expect(retriedAuth).toMatchObject({
      token: "shared-token",
      deviceToken: "stored-device-token",
    });
    client.stop();
  });

  it("retries with stored device token when server recommends retry_with_device_token", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    const retriedAuth = await expectRetriedConnectAuth({
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_UNAUTHORIZED", recommendedNextStep: "retry_with_device_token" },
    });
    expect(retriedAuth).toMatchObject({
      token: "shared-token",
      deviceToken: "stored-device-token",
    });
    client.stop();
  });

  it("does not auto-reconnect on AUTH_TOKEN_MISSING connect failures", async () => {
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_TOKEN_MISSING" },
    });
  });

  it("does not auto-reconnect on token mismatch when retry is not trusted", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "wss://gateway.example.com:18789",
      token: "shared-token",
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    });
  });
});

describe("GatewayClient reconnect retry cap", () => {
  beforeEach(() => {
    wsInstances.length = 0;
  });

  it("stops reconnecting after maxReconnectRetries is reached", async () => {
    vi.useFakeTimers();
    try {
      const onConnectError = vi.fn();
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        maxReconnectRetries: 2,
        onConnectError,
      });

      client.start();
      // Close the socket 3 times to exceed the 2-retry cap
      for (let i = 0; i < 3; i++) {
        const ws = getLatestWs();
        ws.emitOpen();
        ws.emitClose(1006, "connection lost");
        await vi.advanceTimersByTimeAsync(60_000);
      }

      expect(onConnectError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("reconnect limit reached"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats NaN reconnectCount as 0 and still enforces the cap", async () => {
    vi.useFakeTimers();
    try {
      const onConnectError = vi.fn();
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        maxReconnectRetries: 1,
        onConnectError,
      });

      // Force reconnectCount to NaN via the private field
      (client as unknown as { reconnectCount: number }).reconnectCount = NaN;

      client.start();
      const ws = getLatestWs();
      ws.emitOpen();
      ws.emitClose(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(60_000);

      // After NaN is reset to 0, the first reconnect should succeed (count becomes 1)
      expect(wsInstances.length).toBeGreaterThan(1);

      // Now the second close should hit the cap (count becomes 2 > 1)
      const ws2 = getLatestWs();
      ws2.emitOpen();
      ws2.emitClose(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(onConnectError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("reconnect limit reached"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops immediately when maxReconnectRetries is 0", async () => {
    vi.useFakeTimers();
    try {
      const onConnectError = vi.fn();
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        maxReconnectRetries: 0,
        onConnectError,
      });

      client.start();
      const ws = getLatestWs();
      ws.emitOpen();
      ws.emitClose(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(onConnectError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("reconnect limit reached"),
        }),
      );
      // No new WebSocket should have been created beyond the initial one
      expect(wsInstances.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets reconnectCount on successful hello-ok", async () => {
    vi.useFakeTimers();
    try {
      const onConnectError = vi.fn();
      const onHelloOk = vi.fn();
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        maxReconnectRetries: 2,
        onConnectError,
        onHelloOk,
      });

      client.start();

      // First close triggers reconnect (reconnectCount = 1)
      const ws1 = getLatestWs();
      ws1.emitOpen();
      ws1.emitClose(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(60_000);

      // Second connection succeeds with hello-ok, resetting reconnectCount
      const ws2 = getLatestWs();
      ws2.emitOpen();
      // Simulate connect challenge
      ws2.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-reset" },
        }),
      );
      // Find the connect request id and send a hello-ok response
      const connectFrame = ws2.sent.find((f) => f.includes('"method":"connect"'));
      expect(connectFrame).toBeTruthy();
      const { id: connectId } = JSON.parse(connectFrame!) as { id: string };
      ws2.emitMessage(JSON.stringify({ type: "res", id: connectId, ok: true, payload: {} }));
      await vi.advanceTimersByTimeAsync(0);
      expect(onHelloOk).toHaveBeenCalled();

      // Now close again — reconnectCount was reset so we get 2 more retries
      ws2.emitClose(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(60_000);
      const ws3 = getLatestWs();
      ws3.emitOpen();
      ws3.emitClose(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(60_000);

      // 2 retries used, 3rd close should hit the cap
      const ws4 = getLatestWs();
      ws4.emitOpen();
      ws4.emitClose(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(onConnectError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("reconnect limit reached"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to unbounded retries when maxReconnectRetries is not set", async () => {
    vi.useFakeTimers();
    try {
      const onConnectError = vi.fn();
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        onConnectError,
      });

      client.start();
      // Simulate 20 consecutive failures — should NOT trigger the reconnect cap
      for (let i = 0; i < 20; i++) {
        const ws = getLatestWs();
        ws.emitOpen();
        ws.emitClose(1006, "connection lost");
        await vi.advanceTimersByTimeAsync(60_000);
      }

      // onConnectError may fire for challenge timeouts, but never for reconnect limit
      const limitCalls = onConnectError.mock.calls.filter((args: unknown[]) =>
        (args[0] as Error).message.includes("reconnect limit reached"),
      );
      expect(limitCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats NaN maxReconnectRetries option as unbounded", async () => {
    vi.useFakeTimers();
    try {
      const onConnectError = vi.fn();
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        maxReconnectRetries: NaN,
        onConnectError,
      });

      client.start();
      for (let i = 0; i < 15; i++) {
        const ws = getLatestWs();
        ws.emitOpen();
        ws.emitClose(1006, "connection lost");
        await vi.advanceTimersByTimeAsync(60_000);
      }

      const limitCalls = onConnectError.mock.calls.filter((args: unknown[]) =>
        (args[0] as Error).message.includes("reconnect limit reached"),
      );
      expect(limitCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats Infinity maxReconnectRetries option as unbounded", async () => {
    vi.useFakeTimers();
    try {
      const onConnectError = vi.fn();
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        maxReconnectRetries: Infinity,
        onConnectError,
      });

      client.start();
      for (let i = 0; i < 15; i++) {
        const ws = getLatestWs();
        ws.emitOpen();
        ws.emitClose(1006, "connection lost");
        await vi.advanceTimersByTimeAsync(60_000);
      }

      const limitCalls = onConnectError.mock.calls.filter((args: unknown[]) =>
        (args[0] as Error).message.includes("reconnect limit reached"),
      );
      expect(limitCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats Infinity reconnectCount as 0 and still enforces the cap", async () => {
    vi.useFakeTimers();
    try {
      const onConnectError = vi.fn();
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        maxReconnectRetries: 1,
        onConnectError,
      });

      (client as unknown as { reconnectCount: number }).reconnectCount = Infinity;

      client.start();
      const ws = getLatestWs();
      ws.emitOpen();
      ws.emitClose(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(60_000);

      // After Infinity is reset to 0, reconnect should proceed
      expect(wsInstances.length).toBeGreaterThan(1);

      const ws2 = getLatestWs();
      ws2.emitOpen();
      ws2.emitClose(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(onConnectError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("reconnect limit reached"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
