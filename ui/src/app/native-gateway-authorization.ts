import type { ConnectParams } from "@openclaw/gateway-client/browser";
import {
  normalizeGatewayClientId,
  normalizeGatewayClientMode,
} from "@openclaw/gateway-protocol/client-info";
import { isRecord, isStringArray } from "@openclaw/normalization-core/record-coerce";
import { t } from "../i18n/index.ts";

export type NativeGatewayAuthorization = {
  client: ConnectParams["client"];
  scopes: string[];
  auth:
    | { deviceToken: string; token?: never; password?: never }
    | { token: string; deviceToken?: never; password?: never }
    | { password: string; token?: never; deviceToken?: never }
    | { deviceToken?: never; token?: never; password?: never };
  device: NonNullable<ConnectParams["device"]>;
};

function readNativeCredential(value: unknown): NativeGatewayAuthorization["auth"] {
  // Preserve the accepted native method. In particular, role-configured Gateways
  // distinguish shared-owner token/password auth from device-token authentication.
  if (!isRecord(value)) {
    throw new Error("The app returned an invalid Gateway credential. Reconnect in the app.");
  }
  const keys = Object.keys(value);
  // Ingress-authenticated sessions sign device proof without a reusable Gateway credential.
  if (keys.length === 0) {
    return {};
  }
  if (keys.length === 1) {
    const credential = value[keys[0]!];
    if (typeof credential === "string" && credential) {
      switch (keys[0]) {
        case "deviceToken":
          return { deviceToken: credential };
        case "token":
          return { token: credential };
        case "password":
          return { password: credential };
        default:
          break;
      }
    }
  }
  throw new Error(t("runtimeErrors.nativeCredential"));
}

export function readAuthorization(
  value: unknown,
  challenge: { nonce: string; signedAt: number },
): NativeGatewayAuthorization {
  const result = isRecord(value) ? value : {};
  const client = isRecord(result.client) ? result.client : {};
  const device = isRecord(result.device) ? result.device : {};
  const id = normalizeGatewayClientId(typeof client.id === "string" ? client.id : undefined);
  const mode = normalizeGatewayClientMode(
    typeof client.mode === "string" ? client.mode : undefined,
  );
  if (
    !id ||
    !mode ||
    typeof client.version !== "string" ||
    typeof client.platform !== "string" ||
    !isStringArray(result.scopes) ||
    typeof device.id !== "string" ||
    typeof device.publicKey !== "string" ||
    typeof device.signature !== "string" ||
    device.nonce !== challenge.nonce ||
    device.signedAt !== challenge.signedAt
  ) {
    throw new Error(t("runtimeErrors.nativeAuthorization"));
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
    auth: readNativeCredential(result.auth),
    device: {
      id: device.id,
      publicKey: device.publicKey,
      signature: device.signature,
      nonce: challenge.nonce,
      signedAt: challenge.signedAt,
    },
  };
}
