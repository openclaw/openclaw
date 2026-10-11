import {
  normalizeGatewayClientId,
  normalizeGatewayClientMode,
} from "@openclaw/gateway-protocol/client-info";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { NativeGatewayAuthorization } from "./native-gateway-auth.ts";

type ChallengeMessage = { nonce: string; signedAt: number };

function readNativeCredential(value: Record<string, unknown>): NativeGatewayAuthorization["auth"] {
  // Preserve the accepted native method. In particular, role-configured Gateways
  // distinguish shared-owner token/password auth from device-token authentication.
  if (Object.keys(value).length === 1) {
    if (typeof value.deviceToken === "string" && value.deviceToken) {
      return { deviceToken: value.deviceToken };
    }
    if (typeof value.token === "string" && value.token) {
      return { token: value.token };
    }
    if (typeof value.password === "string" && value.password) {
      return { password: value.password };
    }
  }
  throw new Error("The app returned an invalid Gateway credential. Reconnect in the app.");
}

export function readAuthorization(
  value: unknown,
  challenge: ChallengeMessage,
): NativeGatewayAuthorization {
  const result = isRecord(value) ? value : {};
  const client = isRecord(result.client) ? result.client : {};
  const device = isRecord(result.device) ? result.device : {};
  const auth = isRecord(result.auth) ? result.auth : {};
  const id = normalizeGatewayClientId(typeof client.id === "string" ? client.id : undefined);
  const mode = normalizeGatewayClientMode(
    typeof client.mode === "string" ? client.mode : undefined,
  );
  if (
    !id ||
    !mode ||
    typeof client.version !== "string" ||
    typeof client.platform !== "string" ||
    !Array.isArray(result.scopes) ||
    !result.scopes.every((scope): scope is string => typeof scope === "string") ||
    typeof device.id !== "string" ||
    typeof device.publicKey !== "string" ||
    typeof device.signature !== "string" ||
    device.nonce !== challenge.nonce ||
    device.signedAt !== challenge.signedAt
  ) {
    throw new Error("The app returned an invalid Gateway authorization. Reconnect in the app.");
  }
  let nativeAuth: NativeGatewayAuthorization["auth"];
  let expectedHelloAuth: NativeGatewayAuthorization["expectedHelloAuth"];
  if (Object.keys(auth).length === 0) {
    const recoveryScope = result.expectedRecoveryScope;
    if (
      !isRecord(result.auth) ||
      result.requiredAuthMethod !== "tailscale" ||
      typeof recoveryScope !== "string" ||
      recoveryScope.trim().length === 0
    ) {
      throw new Error("The app returned an invalid Gateway credential. Reconnect in the app.");
    }
    nativeAuth = {};
    expectedHelloAuth = { method: "tailscale", recoveryScope };
  } else {
    nativeAuth = readNativeCredential(auth);
  }
  return {
    client: {
      id,
      mode,
      version: client.version,
      platform: client.platform,
      ...(typeof client.deviceFamily === "string" ? { deviceFamily: client.deviceFamily } : {}),
      ...(typeof client.instanceId === "string" ? { instanceId: client.instanceId } : {}),
    },
    scopes: result.scopes,
    auth: nativeAuth,
    ...(expectedHelloAuth ? { expectedHelloAuth } : {}),
    device: {
      id: device.id,
      publicKey: device.publicKey,
      signature: device.signature,
      nonce: challenge.nonce,
      signedAt: challenge.signedAt,
    },
  };
}
