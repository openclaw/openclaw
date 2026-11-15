// Stored device auth and requested operator scopes for TUI Gateway connections.
import { loadOriginDeviceToken } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresentAsync } from "../infra/device-identity-async.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import {
  intersectOperatorScopes,
  operatorScopeSatisfied,
} from "../shared/operator-scope-compat.js";

const TUI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
];

export async function loadStoredOriginDeviceAuth(
  deviceAuthScope: string,
): Promise<DeviceAuthEntry | null> {
  try {
    const identity = await loadDeviceIdentityIfPresentAsync();
    return identity
      ? await loadOriginDeviceToken({
          gatewayScope: deviceAuthScope,
          deviceId: identity.deviceId,
          role: "operator",
        })
      : null;
  } catch {
    return null;
  }
}

export async function hasStoredOriginDeviceAuth(deviceAuthScope: string): Promise<boolean> {
  return Boolean((await loadStoredOriginDeviceAuth(deviceAuthScope))?.token);
}

/**
 * A device paired with only session scopes (a team guest) connects within that
 * grant; requesting the default scopes would file a scope-upgrade request.
 * Returns undefined for every other grant, which keeps the default request.
 */
export function narrowTuiScopesToGrant(grantedScopes: readonly string[]): string[] | undefined {
  const sessionOnly =
    grantedScopes.some((scope) => scope.startsWith("operator.sessions.")) &&
    !TUI_OPERATOR_SCOPES.some((scope) => operatorScopeSatisfied(scope, grantedScopes));
  return sessionOnly ? intersectOperatorScopes(TUI_OPERATOR_SCOPES, grantedScopes) : undefined;
}

export function resolveTuiOperatorScopes(grantedScopes: readonly string[] = []): string[] {
  return narrowTuiScopesToGrant(grantedScopes) ?? [...TUI_OPERATOR_SCOPES];
}
