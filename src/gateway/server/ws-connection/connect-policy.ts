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
  _sharedAuthOk: boolean,
  trustedProxyAuthOk = false,
): boolean {
  // When dangerouslyDisableDeviceAuth is true, skip pairing entirely
  // This is the intended behavior for HTTP-only deployments
  if (policy.dangerouslyDisableDeviceAuth) {
    return true;
  }
  if (trustedProxyAuthOk) {
    return true;
  }
  // Note: sharedAuthOk alone no longer skips pairing - must use dangerouslyDisableDeviceAuth
  // This is intentional: shared auth should still require device identity for security
  return false;
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
  // When dangerouslyDisableDeviceAuth is true, always allow (skip all device identity checks)
  // This is the intended behavior for HTTP-only deployments
  if (params.isControlUi && params.controlUiAuthPolicy.dangerouslyDisableDeviceAuth) {
    return { kind: "allow" };
  }
  if (params.hasDeviceIdentity) {
    return { kind: "allow" };
  }
  if (params.isControlUi && params.trustedProxyAuthOk) {
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
