import { verifyDeviceSignature } from "../../../infra/device-identity.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { GatewayAuthResult } from "../../auth.js";
import { buildDeviceAuthPayload, buildDeviceAuthPayloadV3 } from "../../device-auth.js";
import { isLoopbackAddress } from "../../net.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../protocol/client-info.js";
import type { ConnectParams } from "../../protocol/index.js";
import type { AuthProvidedKind } from "./auth-messages.js";

export const BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP = "198.18.0.1";

export type HandshakeBrowserSecurityContext = {
  hasBrowserOriginHeader: boolean;
  enforceOriginCheckForAnyClient: boolean;
  rateLimitClientIp: string | undefined;
  authRateLimiter?: AuthRateLimiter;
};

type HandshakeConnectAuth = {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
};

export function resolveHandshakeBrowserSecurityContext(params: {
  requestOrigin?: string;
  clientIp: string | undefined;
  rateLimiter?: AuthRateLimiter;
  browserRateLimiter?: AuthRateLimiter;
}): HandshakeBrowserSecurityContext {
  const hasBrowserOriginHeader = Boolean(
    params.requestOrigin && params.requestOrigin.trim() !== "",
  );
  return {
    hasBrowserOriginHeader,
    enforceOriginCheckForAnyClient: hasBrowserOriginHeader,
    rateLimitClientIp:
      hasBrowserOriginHeader && isLoopbackAddress(params.clientIp)
        ? BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP
        : params.clientIp,
    authRateLimiter:
      hasBrowserOriginHeader && params.browserRateLimiter
        ? params.browserRateLimiter
        : params.rateLimiter,
  };
}

export function shouldAllowSilentLocalPairing(params: {
  isLocalClient: boolean;
  hasBrowserOriginHeader: boolean;
  isControlUi: boolean;
  isWebchat: boolean;
  reason: "not-paired" | "role-upgrade" | "scope-upgrade" | "metadata-upgrade";
}): boolean {
  return (
    params.isLocalClient &&
    (!params.hasBrowserOriginHeader || params.isControlUi || params.isWebchat) &&
    (params.reason === "not-paired" || params.reason === "scope-upgrade")
  );
}

export function shouldSkipBackendSelfPairing(params: {
  connectParams: ConnectParams;
  isLocalClient: boolean;
  hasBrowserOriginHeader: boolean;
  sharedAuthOk: boolean;
  authMethod: GatewayAuthResult["method"];
}): boolean {
  const isGatewayBackendClient =
    params.connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT &&
    params.connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND;
  if (!isGatewayBackendClient) {
    return false;
  }
  const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
  return (
    params.isLocalClient &&
    !params.hasBrowserOriginHeader &&
    params.sharedAuthOk &&
    usesSharedSecretAuth
  );
}

function resolveSignatureToken(connectParams: ConnectParams): string | null {
  return (
    connectParams.auth?.token ??
    connectParams.auth?.deviceToken ??
    connectParams.auth?.bootstrapToken ??
    null
  );
}

export function resolveDeviceSignaturePayloadVersion(params: {
  device: {
    id: string;
    signature: string;
    publicKey: string;
  };
  connectParams: ConnectParams;
  role: string;
  scopes: string[];
  signedAtMs: number;
  nonce: string;
}): "v3" | "v2" | null {
  const signatureToken = resolveSignatureToken(params.connectParams);
  const payloadV3 = buildDeviceAuthPayloadV3({
    deviceId: params.device.id,
    clientId: params.connectParams.client.id,
    clientMode: params.connectParams.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs: params.signedAtMs,
    token: signatureToken,
    nonce: params.nonce,
    platform: params.connectParams.client.platform,
    deviceFamily: params.connectParams.client.deviceFamily,
  });
  if (verifyDeviceSignature(params.device.publicKey, payloadV3, params.device.signature)) {
    return "v3";
  }

  const payloadV2 = buildDeviceAuthPayload({
    deviceId: params.device.id,
    clientId: params.connectParams.client.id,
    clientMode: params.connectParams.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs: params.signedAtMs,
    token: signatureToken,
    nonce: params.nonce,
  });
  if (verifyDeviceSignature(params.device.publicKey, payloadV2, params.device.signature)) {
    return "v2";
  }
  return null;
}

export function resolveAuthProvidedKind(
  connectAuth: HandshakeConnectAuth | null | undefined,
): AuthProvidedKind {
  return connectAuth?.password
    ? "password"
    : connectAuth?.token
      ? "token"
      : connectAuth?.bootstrapToken
        ? "bootstrap-token"
        : connectAuth?.deviceToken
          ? "device-token"
          : "none";
}

export function resolveUnauthorizedHandshakeContext(params: {
  connectAuth: HandshakeConnectAuth | null | undefined;
  failedAuth: GatewayAuthResult;
  hasDeviceIdentity: boolean;
}): {
  authProvided: AuthProvidedKind;
  canRetryWithDeviceToken: boolean;
  recommendedNextStep:
    | "retry_with_device_token"
    | "update_auth_configuration"
    | "update_auth_credentials"
    | "wait_then_retry"
    | "review_auth_configuration";
} {
  const authProvided = resolveAuthProvidedKind(params.connectAuth);
  const canRetryWithDeviceToken =
    params.failedAuth.reason === "token_mismatch" &&
    params.hasDeviceIdentity &&
    authProvided === "token" &&
    !params.connectAuth?.deviceToken;
  if (canRetryWithDeviceToken) {
    return {
      authProvided,
      canRetryWithDeviceToken,
      recommendedNextStep: "retry_with_device_token",
    };
  }
  switch (params.failedAuth.reason) {
    case "token_missing":
    case "token_missing_config":
    case "password_missing":
    case "password_missing_config":
      return {
        authProvided,
        canRetryWithDeviceToken,
        recommendedNextStep: "update_auth_configuration",
      };
    case "token_mismatch":
    case "password_mismatch":
    case "device_token_mismatch":
      return {
        authProvided,
        canRetryWithDeviceToken,
        recommendedNextStep: "update_auth_credentials",
      };
    case "rate_limited":
      return {
        authProvided,
        canRetryWithDeviceToken,
        recommendedNextStep: "wait_then_retry",
      };
    default:
      return {
        authProvided,
        canRetryWithDeviceToken,
        recommendedNextStep: "review_auth_configuration",
      };
  }
}
