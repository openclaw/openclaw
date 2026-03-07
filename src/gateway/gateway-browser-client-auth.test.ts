import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadDeviceAuthTokenMock,
  clearDeviceAuthTokenMock,
  storeDeviceAuthTokenMock,
  loadOrCreateDeviceIdentityMock,
  signDevicePayloadMock,
} = vi.hoisted(() => ({
  loadDeviceAuthTokenMock: vi.fn(),
  clearDeviceAuthTokenMock: vi.fn(),
  storeDeviceAuthTokenMock: vi.fn(),
  loadOrCreateDeviceIdentityMock: vi.fn(),
  signDevicePayloadMock: vi.fn(),
}));

vi.mock("../../ui/src/ui/device-auth.ts", () => ({
  loadDeviceAuthToken: loadDeviceAuthTokenMock,
  clearDeviceAuthToken: clearDeviceAuthTokenMock,
  storeDeviceAuthToken: storeDeviceAuthTokenMock,
}));

vi.mock("../../ui/src/ui/device-identity.ts", () => ({
  loadOrCreateDeviceIdentity: loadOrCreateDeviceIdentityMock,
  signDevicePayload: signDevicePayloadMock,
}));

import { GatewayBrowserClient } from "../../ui/src/ui/gateway.ts";

type GatewayBrowserClientPrivate = {
  request: (method: string, params?: unknown) => Promise<unknown>;
  sendConnect: () => Promise<void>;
  lastGoodAuthToken?: string;
};

function asClientPrivate(client: GatewayBrowserClient): GatewayBrowserClientPrivate {
  return client as unknown as GatewayBrowserClientPrivate;
}

describe("GatewayBrowserClient reconnect auth", () => {
  beforeEach(() => {
    loadDeviceAuthTokenMock.mockReset();
    clearDeviceAuthTokenMock.mockReset();
    storeDeviceAuthTokenMock.mockReset();
    loadOrCreateDeviceIdentityMock.mockReset();
    signDevicePayloadMock.mockReset();

    loadOrCreateDeviceIdentityMock.mockResolvedValue({
      deviceId: "dev-1",
      publicKey: "pub",
      privateKey: "priv",
    });
    signDevicePayloadMock.mockResolvedValue("sig");
  });

  it("falls back to shared token when stored device token is blank", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "   ",
      role: "operator",
      scopes: [],
      updatedAtMs: Date.now(),
    });

    const client = asClientPrivate(
      new GatewayBrowserClient({
        url: "ws://127.0.0.1:18789",
        token: "shared-token",
      }),
    );

    let connectParams: unknown;
    client.request = vi.fn(async (_method: string, params: unknown) => {
      connectParams = params;
      return { type: "hello-ok", protocol: 3 };
    });

    await client.sendConnect();

    expect((connectParams as { auth?: { token?: string } } | undefined)?.auth?.token).toBe(
      "shared-token",
    );
  });

  it("reuses last known good token when current sources are unavailable", async () => {
    loadDeviceAuthTokenMock.mockReturnValue(null);

    const client = asClientPrivate(
      new GatewayBrowserClient({
        url: "ws://127.0.0.1:18789",
      }),
    );
    client.lastGoodAuthToken = "cached-token";

    let connectParams: unknown;
    client.request = vi.fn(async (_method: string, params: unknown) => {
      connectParams = params;
      return { type: "hello-ok", protocol: 3 };
    });

    await client.sendConnect();

    expect((connectParams as { auth?: { token?: string } } | undefined)?.auth?.token).toBe(
      "cached-token",
    );
  });
});
