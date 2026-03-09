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

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    let connectParams: any;
    (client as any).request = vi.fn(async (_method: string, params: unknown) => {
      connectParams = params;
      return { type: "hello-ok", protocol: 3 };
    });

    await (client as any).sendConnect();

    expect(connectParams?.auth?.token).toBe("shared-token");
  });

  it("reuses last known good token when current sources are unavailable", async () => {
    loadDeviceAuthTokenMock.mockReturnValue(null);

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });
    (client as any).lastGoodAuthToken = "cached-token";

    let connectParams: any;
    (client as any).request = vi.fn(async (_method: string, params: unknown) => {
      connectParams = params;
      return { type: "hello-ok", protocol: 3 };
    });

    await (client as any).sendConnect();

    expect(connectParams?.auth?.token).toBe("cached-token");
  });
});
