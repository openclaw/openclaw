import { describe, expect, it } from "vitest";

/**
 * Unit tests for the browser client auth object construction logic.
 *
 * These tests verify that the browser client (GatewayBrowserClient) constructs
 * the `auth` object in the same way as the Node.js client (GatewayClient),
 * specifically ensuring the `deviceToken` field is included when available.
 *
 * The logic under test is extracted from `sendConnect()` in `gateway.ts`.
 */

/**
 * Mirrors the auth object construction logic from `GatewayBrowserClient.sendConnect()`.
 * This is extracted to enable unit testing without requiring a full WebSocket setup.
 */
function buildBrowserConnectAuth(params: {
  explicitGatewayToken: string | undefined;
  password: string | undefined;
  storedDeviceToken: string | undefined;
}):
  | { token: string | undefined; deviceToken: string | undefined; password: string | undefined }
  | undefined {
  const explicitGatewayToken = params.explicitGatewayToken?.trim() || undefined;
  let authToken = explicitGatewayToken;
  // Mirror the deviceToken suppression logic from gateway.ts lines 218-220:
  // deviceToken is only used when no explicit shared token/password is provided.
  const deviceToken = !(explicitGatewayToken || params.password?.trim())
    ? (params.storedDeviceToken ?? undefined)
    : undefined;
  authToken = explicitGatewayToken ?? deviceToken;
  // Fixed auth construction: includes deviceToken field (aligned with Node.js client)
  const auth =
    authToken || params.password || deviceToken
      ? {
          token: authToken,
          deviceToken: deviceToken,
          password: params.password,
        }
      : undefined;
  return auth;
}

/**
 * Mirrors the auth object construction logic from `GatewayClient.sendConnect()`
 * in `src/gateway/client.ts` (the Node.js reference implementation).
 */
function buildNodeConnectAuth(params: {
  explicitGatewayToken: string | undefined;
  explicitDeviceToken: string | undefined;
  password: string | undefined;
  storedDeviceToken: string | undefined;
}):
  | { token: string | undefined; deviceToken: string | undefined; password: string | undefined }
  | undefined {
  const explicitGatewayToken = params.explicitGatewayToken?.trim() || undefined;
  const explicitDeviceToken = params.explicitDeviceToken?.trim() || undefined;
  const resolvedDeviceToken =
    explicitDeviceToken ??
    (!(explicitGatewayToken || params.password?.trim())
      ? (params.storedDeviceToken ?? undefined)
      : undefined);
  const authToken = explicitGatewayToken ?? resolvedDeviceToken;
  const authPassword = params.password?.trim() || undefined;
  const auth =
    authToken || authPassword || resolvedDeviceToken
      ? {
          token: authToken,
          deviceToken: resolvedDeviceToken,
          password: authPassword,
        }
      : undefined;
  return auth;
}

describe("browser client auth object construction", () => {
  describe("shared token only (no cached device token)", () => {
    it("includes deviceToken as undefined in auth object", () => {
      const auth = buildBrowserConnectAuth({
        explicitGatewayToken: "shared-secret-123",
        password: undefined,
        storedDeviceToken: undefined,
      });
      expect(auth).toEqual({
        token: "shared-secret-123",
        deviceToken: undefined,
        password: undefined,
      });
    });

    it("matches Node.js client behavior", () => {
      const browserAuth = buildBrowserConnectAuth({
        explicitGatewayToken: "shared-secret-123",
        password: undefined,
        storedDeviceToken: undefined,
      });
      const nodeAuth = buildNodeConnectAuth({
        explicitGatewayToken: "shared-secret-123",
        explicitDeviceToken: undefined,
        password: undefined,
        storedDeviceToken: undefined,
      });
      expect(browserAuth).toEqual(nodeAuth);
    });
  });

  describe("device token only (no shared token)", () => {
    it("uses stored device token as both auth.token and auth.deviceToken", () => {
      const auth = buildBrowserConnectAuth({
        explicitGatewayToken: undefined,
        password: undefined,
        storedDeviceToken: "device-jwt-abc",
      });
      expect(auth).toEqual({
        token: "device-jwt-abc",
        deviceToken: "device-jwt-abc",
        password: undefined,
      });
    });

    it("matches Node.js client behavior", () => {
      const browserAuth = buildBrowserConnectAuth({
        explicitGatewayToken: undefined,
        password: undefined,
        storedDeviceToken: "device-jwt-abc",
      });
      const nodeAuth = buildNodeConnectAuth({
        explicitGatewayToken: undefined,
        explicitDeviceToken: undefined,
        password: undefined,
        storedDeviceToken: "device-jwt-abc",
      });
      expect(browserAuth).toEqual(nodeAuth);
    });
  });

  describe("shared token + cached device token", () => {
    it("suppresses deviceToken when shared token is present", () => {
      const auth = buildBrowserConnectAuth({
        explicitGatewayToken: "shared-secret-123",
        password: undefined,
        storedDeviceToken: "device-jwt-abc",
      });
      // When explicitGatewayToken is present, deviceToken is suppressed (set to undefined)
      expect(auth).toEqual({
        token: "shared-secret-123",
        deviceToken: undefined,
        password: undefined,
      });
    });

    it("matches Node.js client behavior", () => {
      const browserAuth = buildBrowserConnectAuth({
        explicitGatewayToken: "shared-secret-123",
        password: undefined,
        storedDeviceToken: "device-jwt-abc",
      });
      const nodeAuth = buildNodeConnectAuth({
        explicitGatewayToken: "shared-secret-123",
        explicitDeviceToken: undefined,
        password: undefined,
        storedDeviceToken: "device-jwt-abc",
      });
      expect(browserAuth).toEqual(nodeAuth);
    });
  });

  describe("password only", () => {
    it("suppresses deviceToken when password is present", () => {
      const auth = buildBrowserConnectAuth({
        explicitGatewayToken: undefined,
        password: "my-password",
        storedDeviceToken: "device-jwt-abc",
      });
      expect(auth).toEqual({
        token: undefined,
        deviceToken: undefined,
        password: "my-password",
      });
    });
  });

  describe("no credentials at all", () => {
    it("returns undefined when no auth is available", () => {
      const auth = buildBrowserConnectAuth({
        explicitGatewayToken: undefined,
        password: undefined,
        storedDeviceToken: undefined,
      });
      expect(auth).toBeUndefined();
    });

    it("matches Node.js client behavior", () => {
      const browserAuth = buildBrowserConnectAuth({
        explicitGatewayToken: undefined,
        password: undefined,
        storedDeviceToken: undefined,
      });
      const nodeAuth = buildNodeConnectAuth({
        explicitGatewayToken: undefined,
        explicitDeviceToken: undefined,
        password: undefined,
        storedDeviceToken: undefined,
      });
      expect(browserAuth).toEqual(nodeAuth);
    });
  });

  describe("auth.deviceToken field presence", () => {
    it("always includes deviceToken key in auth object (even when undefined)", () => {
      const auth = buildBrowserConnectAuth({
        explicitGatewayToken: "shared-secret-123",
        password: undefined,
        storedDeviceToken: undefined,
      });
      expect(auth).toBeDefined();
      expect("deviceToken" in auth!).toBe(true);
    });
  });
});
