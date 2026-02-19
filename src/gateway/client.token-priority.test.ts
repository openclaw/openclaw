import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const deviceAuthStoreMock = vi.hoisted(() => ({
  storedToken: null as string | null,
  loadDeviceAuthToken: vi.fn(),
  storeDeviceAuthToken: vi.fn(),
  clearDeviceAuthToken: vi.fn(),
}));

vi.mock("../infra/device-auth-store.js", () => ({
  loadDeviceAuthToken: deviceAuthStoreMock.loadDeviceAuthToken,
  storeDeviceAuthToken: deviceAuthStoreMock.storeDeviceAuthToken,
  clearDeviceAuthToken: deviceAuthStoreMock.clearDeviceAuthToken,
}));

const { GatewayClient } = await import("./client.js");

function makeDeviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    deviceId: "device-token-priority-test",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const TEST_IDENTITY = makeDeviceIdentity();

type ConnectFrame = {
  params?: {
    auth?: {
      token?: string;
    };
  };
};

function sendConnectWithAuth(opts: {
  token?: string;
  explicitToken?: string;
  storedToken?: string | null;
  wsReadyState?: number;
}) {
  deviceAuthStoreMock.storedToken = opts.storedToken ?? null;
  const send = vi.fn();
  const close = vi.fn();

  const client = new GatewayClient({
    url: "ws://127.0.0.1:18789",
    token: opts.token,
    explicitToken: opts.explicitToken,
    deviceIdentity: TEST_IDENTITY,
  });

  (
    client as unknown as {
      ws: {
        readyState: number;
        send: (data: string) => void;
        close: (code: number, reason: string) => void;
      };
      sendConnect: () => void;
    }
  ).ws = {
    readyState: opts.wsReadyState ?? WebSocket.OPEN,
    send,
    close,
  };

  (client as unknown as { sendConnect: () => void }).sendConnect();

  return { send, close, client };
}

function readAuthToken(send: ReturnType<typeof vi.fn>): string | undefined {
  const payload = send.mock.calls[0]?.[0];
  const frame = JSON.parse(String(payload)) as ConnectFrame;
  return frame.params?.auth?.token;
}

describe("GatewayClient token priority", () => {
  beforeEach(() => {
    deviceAuthStoreMock.storedToken = null;
    deviceAuthStoreMock.loadDeviceAuthToken.mockReset();
    deviceAuthStoreMock.storeDeviceAuthToken.mockReset();
    deviceAuthStoreMock.clearDeviceAuthToken.mockReset();
    deviceAuthStoreMock.loadDeviceAuthToken.mockImplementation(
      (params: { role?: string } | undefined) => {
        if (!deviceAuthStoreMock.storedToken) {
          return null;
        }
        return {
          token: deviceAuthStoreMock.storedToken,
          role: params?.role ?? "operator",
          scopes: [],
          updatedAtMs: Date.now(),
        };
      },
    );
  });

  it("prefers explicitToken over stored token", () => {
    const { send } = sendConnectWithAuth({
      explicitToken: "explicit-token",
      token: "config-token",
      storedToken: "stored-token",
    });

    expect(readAuthToken(send)).toBe("explicit-token");
  });

  it("prefers stored token over passive token", () => {
    const { send } = sendConnectWithAuth({
      token: "config-token",
      storedToken: "stored-token",
    });

    expect(readAuthToken(send)).toBe("stored-token");
  });

  it("uses passive token when no stored token exists", () => {
    const { send } = sendConnectWithAuth({ token: "config-token", storedToken: null });

    expect(readAuthToken(send)).toBe("config-token");
  });

  it("uses undefined token when nothing is configured", () => {
    const { send } = sendConnectWithAuth({ storedToken: null });
    const payload = send.mock.calls[0]?.[0];
    const frame = JSON.parse(String(payload)) as ConnectFrame;

    expect(frame.params?.auth).toBeUndefined();
  });

  it("clears stored token on connect failure when shared auth fallback is available", async () => {
    sendConnectWithAuth({
      token: "config-token",
      storedToken: "stored-token",
      wsReadyState: WebSocket.CONNECTING,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(deviceAuthStoreMock.clearDeviceAuthToken).toHaveBeenCalledWith({
      deviceId: TEST_IDENTITY.deviceId,
      role: "operator",
    });
  });
});
