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
  readyState: number = 0; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

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
    this.readyState = 2;
    this.emitClose(code ?? 1000, reason ?? "");
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emitOpen(): void {
    this.readyState = 1;
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
    this.readyState = 3;
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
          deviceToken?: string;
          password?: string;
        };
      };
    };
    return parsed.params?.auth ?? {};
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

    client.start();
    const ws1 = getLatestWs();
    ws1.emitOpen();
    emitConnectChallenge(ws1);
    const firstConnectRaw = ws1.sent.find((frame) => frame.includes('"method":"connect"'));
    expect(firstConnectRaw).toBeTruthy();
    const firstConnect = JSON.parse(firstConnectRaw ?? "{}") as {
      id?: string;
      params?: { auth?: { token?: string; deviceToken?: string } };
    };
    expect(firstConnect.params?.auth?.token).toBe("shared-token");
    expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

    ws1.emitMessage(
      JSON.stringify({
        type: "res",
        id: firstConnect.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "unauthorized",
          details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
        },
      }),
    );

    await vi.waitFor(() => expect(wsInstances.length).toBeGreaterThan(1), { timeout: 3_000 });
    const ws2 = getLatestWs();
    ws2.emitOpen();
    emitConnectChallenge(ws2, "nonce-2");
    expect(connectFrameFrom(ws2)).toMatchObject({
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

    client.start();
    const ws1 = getLatestWs();
    ws1.emitOpen();
    emitConnectChallenge(ws1);
    const firstConnectRaw = ws1.sent.find((frame) => frame.includes('"method":"connect"'));
    expect(firstConnectRaw).toBeTruthy();
    const firstConnect = JSON.parse(firstConnectRaw ?? "{}") as { id?: string };

    ws1.emitMessage(
      JSON.stringify({
        type: "res",
        id: firstConnect.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "unauthorized",
          details: { code: "AUTH_UNAUTHORIZED", recommendedNextStep: "retry_with_device_token" },
        },
      }),
    );

    await vi.waitFor(() => expect(wsInstances.length).toBeGreaterThan(1), { timeout: 3_000 });
    const ws2 = getLatestWs();
    ws2.emitOpen();
    emitConnectChallenge(ws2, "nonce-2");
    expect(connectFrameFrom(ws2)).toMatchObject({
      token: "shared-token",
      deviceToken: "stored-device-token",
    });
    client.stop();
  });

  it("does not auto-reconnect on AUTH_TOKEN_MISSING connect failures", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    client.start();
    const ws1 = getLatestWs();
    ws1.emitOpen();
    emitConnectChallenge(ws1);
    const firstConnectRaw = ws1.sent.find((frame) => frame.includes('"method":"connect"'));
    expect(firstConnectRaw).toBeTruthy();
    const firstConnect = JSON.parse(firstConnectRaw ?? "{}") as { id?: string };

    ws1.emitMessage(
      JSON.stringify({
        type: "res",
        id: firstConnect.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "unauthorized",
          details: { code: "AUTH_TOKEN_MISSING" },
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);
    client.stop();
    vi.useRealTimers();
  });

  it("does not auto-reconnect on token mismatch when retry is not trusted", async () => {
    vi.useFakeTimers();
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "wss://gateway.example.com:18789",
      token: "shared-token",
    });

    client.start();
    const ws1 = getLatestWs();
    ws1.emitOpen();
    emitConnectChallenge(ws1);
    const firstConnectRaw = ws1.sent.find((frame) => frame.includes('"method":"connect"'));
    expect(firstConnectRaw).toBeTruthy();
    const firstConnect = JSON.parse(firstConnectRaw ?? "{}") as { id?: string };

    ws1.emitMessage(
      JSON.stringify({
        type: "res",
        id: firstConnect.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "unauthorized",
          details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);
    client.stop();
    vi.useRealTimers();
  });
});

describe("GatewayClient reconnect() timer cleanup", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    loadDeviceAuthTokenMock.mockReset();
    clearDeviceAuthTokenMock.mockReset();
    storeDeviceAuthTokenMock.mockReset();
  });

  it("clears the handshake connectTimer so it cannot spuriously close the next socket", async () => {
    vi.useFakeTimers();
    const connectErrors: Error[] = [];
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "tok",
      onConnectError: (err) => connectErrors.push(err),
    });

    // Start and let the WebSocket open — this arms the connect-challenge timeout.
    client.start();
    const ws1 = getLatestWs();
    ws1.emitOpen(); // readyState → 1 (OPEN); queueConnect() arms connectTimer (~2000ms)

    // Simulate ctrl+r mid-handshake (before connect.challenge arrives).
    // Without the fix, the old connectTimer would still be running.
    client.reconnect(); // should clear connectTimer AND close ws1

    // Advance past the original 2 s handshake window.
    // The reconnect backoff fires at 1000 ms, so the second socket will be created.
    await vi.advanceTimersByTimeAsync(1_100);
    const ws2 = getLatestWs();
    expect(wsInstances).toHaveLength(2); // new socket was opened
    ws2.emitOpen(); // second socket enters OPEN state

    // Advance another 1500 ms — if the stale connectTimer were still alive it
    // would fire here (total ~2600 ms from ws1.emitOpen) and close ws2 with a
    // false "connect challenge timeout".
    await vi.advanceTimersByTimeAsync(1_500);

    // The new socket should still be alive (not closed by a stale timer).
    expect(ws2.readyState).toBe(1); // still OPEN
    expect(connectErrors.map((e) => e.message)).not.toContain("gateway connect challenge timeout");

    client.stop();
    vi.useRealTimers();
  });
});
