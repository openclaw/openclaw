import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "../infra/device-identity.js";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const clearDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const storeDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const clearDevicePairingMock = vi.hoisted(() => vi.fn());
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

  close(_code?: number, _reason?: string): void {}

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

vi.mock("../infra/device-pairing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing.js")>();
  return {
    ...actual,
    clearDevicePairing: (...args: unknown[]) => clearDevicePairingMock(...args),
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
    privateKeyPem: "private-key",
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
  beforeEach(() => {
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
});

describe("GatewayClient close handling", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    clearDeviceAuthTokenMock.mockClear();
    clearDeviceAuthTokenMock.mockImplementation(() => undefined);
    clearDevicePairingMock.mockClear();
    clearDevicePairingMock.mockResolvedValue(true);
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
    expect(clearDevicePairingMock).toHaveBeenCalledWith("dev-1");
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
    expect(clearDevicePairingMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: device token mismatch");
    client.stop();
  });

  it("does not break close flow when pairing clear rejects", async () => {
    clearDevicePairingMock.mockRejectedValue(new Error("pairing store unavailable"));
    const onClose = vi.fn();
    const client = createClientWithIdentity("dev-3", onClose);

    client.start();
    expect(() => {
      getLatestWs().emitClose(1008, "unauthorized: device token mismatch");
    }).not.toThrow();

    await Promise.resolve();
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("failed clearing stale device pairing"),
    );
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: device token mismatch");
    client.stop();
  });

  it("does not clear auth state for non-mismatch close reasons", () => {
    const onClose = vi.fn();
    const client = createClientWithIdentity("dev-4", onClose);

    client.start();
    getLatestWs().emitClose(1008, "unauthorized: signature invalid");

    expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
    expect(clearDevicePairingMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: signature invalid");
    client.stop();
  });

  it("does not clear persisted device auth when explicit shared token is provided", () => {
    const onClose = vi.fn();
    const identity: DeviceIdentity = {
      deviceId: "dev-5",
      privateKeyPem: "private-key",
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
    expect(clearDevicePairingMock).not.toHaveBeenCalled();
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
});
