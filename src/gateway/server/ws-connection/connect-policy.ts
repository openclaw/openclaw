import type { GatewayAuthResult } from "../../auth.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../protocol/client-info.js";
import type { ConnectParams } from "../../protocol/index.js";
import type { GatewayRole } from "../../role-policy.js";
import { roleCanSkipDeviceIdentity } from "../../role-policy.js";

export type ControlUiAuthPolicy = {
  allowInsecureAuthConfigured: boolean;
  dangerouslyDisableDeviceAuth: boolean;
  allowBypass: boolean;
  device: ConnectParams["device"] | null | undefined;
};

export function resolveControlUiAuthPolicy(params: {
  isControlUi: boolean;
  controlUiConfig:
    | {
        allowInsecureAuth?: boolean;
        dangerouslyDisableDeviceAuth?: boolean;
      }
    | undefined;
  deviceRaw: ConnectParams["device"] | null | undefined;
}): ControlUiAuthPolicy {
  const allowInsecureAuthConfigured =
    params.isControlUi && params.controlUiConfig?.allowInsecureAuth === true;
  const dangerouslyDisableDeviceAuth =
    params.isControlUi && params.controlUiConfig?.dangerouslyDisableDeviceAuth === true;
  return {
    allowInsecureAuthConfigured,
    dangerouslyDisableDeviceAuth,
    // `allowInsecureAuth` must not bypass secure-context/device-auth requirements.
    allowBypass: dangerouslyDisableDeviceAuth,
    device: dangerouslyDisableDeviceAuth ? null : params.deviceRaw,
  };
}

export function shouldSkipControlUiPairing(
  policy: ControlUiAuthPolicy,
  role: GatewayRole,
  trustedProxyAuthOk = false,
): boolean {
  if (trustedProxyAuthOk) {
    return true;
  }
  // dangerouslyDisableDeviceAuth is the break-glass path for Control UI
  // operators. Keep pairing aligned with the missing-device bypass, including
  // open-auth deployments where there is no shared token/password to prove.
  return role === "operator" && policy.allowBypass;
}

export function isTrustedProxyControlUiOperatorAuth(params: {
  isControlUi: boolean;
  role: GatewayRole;
  authMode: string;
  authOk: boolean;
  authMethod: string | undefined;
}): boolean {
  return (
    params.isControlUi &&
    params.role === "operator" &&
    params.authMode === "trusted-proxy" &&
    params.authOk &&
    params.authMethod === "trusted-proxy"
  );
}

export function shouldSkipBackendSelfPairing(params: {
  connectParams: ConnectParams;
  isLocalClient: boolean;
  hasBrowserOriginHeader: boolean;
  sharedAuthOk: boolean;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
}): boolean {
  const isGatewayBackendClient =
    params.connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT &&
    params.connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND;
  if (!isGatewayBackendClient) {
    return false;
  }
  if (params.hasBrowserOriginHeader || !params.isLocalClient) {
    return false;
  }
  // token/password: sharedAuthOk is set specifically for these in auth-context.ts.
  const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
  // device-token and tailscale are valid backend auth methods, but sharedAuthOk is never
  // set for them in the WS flow (auth-context.ts only sets it for token/password/
  // trusted-proxy). Gate on authOk directly for these instead.
  // bootstrap-token is intentionally excluded: first-time bootstrap connects must still
  // complete pairing so the gateway can mint and persist a device token.
  const usesAuthOkMethod =
    params.authMethod === "device-token" || params.authMethod === "tailscale";
  // When auth is disabled entirely (mode="none"), there is no credential to verify. Restricting
  // backend self-pairing skip to locally attested clients keeps remote callers from turning a
  // client-reported gateway-client/backend label into implicit trust.
  const authIsDisabled = params.authMethod === "none";
  return (
    (params.sharedAuthOk && usesSharedSecretAuth) ||
    (params.authOk && usesAuthOkMethod) ||
    authIsDisabled
  );
}

export function resolveInternalBackendClientAttestation(params: {
  connectParams: ConnectParams;
  hasBrowserOriginHeader: boolean;
  initialIsInternalBackendClient: boolean;
  authMethod: GatewayAuthResult["method"];
  deviceTokenIssued: boolean;
}): boolean {
  if (params.initialIsInternalBackendClient) {
    return true;
  }
  const isGatewayBackendClient =
    params.connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT &&
    params.connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND;
  if (!isGatewayBackendClient || params.hasBrowserOriginHeader) {
    return false;
  }
  return params.authMethod === "bootstrap-token" && params.deviceTokenIssued;
}

export type MissingDeviceIdentityDecision =
  | { kind: "allow" }
  | { kind: "reject-control-ui-insecure-auth" }
  | { kind: "reject-unauthorized" }
  | { kind: "reject-device-required" };

export function evaluateMissingDeviceIdentity(params: {
  hasDeviceIdentity: boolean;
  role: GatewayRole;
  isControlUi: boolean;
  controlUiAuthPolicy: ControlUiAuthPolicy;
  trustedProxyAuthOk?: boolean;
  sharedAuthOk: boolean;
  authOk: boolean;
  hasSharedAuth: boolean;
  isLocalClient: boolean;
}): MissingDeviceIdentityDecision {
  if (params.hasDeviceIdentity) {
    return { kind: "allow" };
  }
  if (params.isControlUi && params.trustedProxyAuthOk) {
    return { kind: "allow" };
  }
  if (params.isControlUi && params.controlUiAuthPolicy.allowBypass && params.role === "operator") {
    // dangerouslyDisableDeviceAuth: true — operator has explicitly opted out of
    // device-identity enforcement for this Control UI.  Allow for operator-role
    // sessions only; node-role sessions must still satisfy device identity so
    // that the break-glass flag cannot be abused to admit device-less node
    // registrations (see #45405 review).
    return { kind: "allow" };
  }
  if (params.isControlUi && !params.controlUiAuthPolicy.allowBypass) {
    // Allow localhost Control UI connections when allowInsecureAuth is configured.
    // Localhost has no network interception risk, and browser SubtleCrypto
    // (needed for device identity) is unavailable in insecure HTTP contexts.
    // Remote connections are still rejected to preserve the MitM protection
    // that the security fix (#20684) intended.
    if (!params.controlUiAuthPolicy.allowInsecureAuthConfigured || !params.isLocalClient) {
      return { kind: "reject-control-ui-insecure-auth" };
    }
  }
  if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) {
    return { kind: "allow" };
  }
  if (!params.authOk && params.hasSharedAuth) {
    return { kind: "reject-unauthorized" };
  }
  return { kind: "reject-device-required" };
}
