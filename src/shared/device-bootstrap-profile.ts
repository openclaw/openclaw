import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "./device-auth.js";
import { roleScopesAllow } from "./operator-scope-compat.js";

export type DeviceBootstrapProfile = {
  roles: string[];
  scopes: string[];
};

export type DeviceBootstrapProfileInput = {
  roles?: readonly string[];
  scopes?: readonly string[];
};

function normalizeBootstrapRoles(roles: readonly string[] | undefined): string[] {
  if (!Array.isArray(roles)) {
    return [];
  }
  const out = new Set<string>();
  for (const role of roles) {
    const normalized = normalizeDeviceAuthRole(role);
    if (normalized) {
      out.add(normalized);
    }
  }
  return [...out].toSorted();
}

export function normalizeDeviceBootstrapProfile(
  input: DeviceBootstrapProfileInput | undefined,
): DeviceBootstrapProfile {
  return {
    roles: normalizeBootstrapRoles(input?.roles),
    scopes: normalizeDeviceAuthScopes(input?.scopes ? [...input.scopes] : []),
  };
}

export const PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile =
  normalizeDeviceBootstrapProfile({
    roles: ["operator", "node"],
    scopes: [
      "operator.read",
      "operator.write",
      "operator.talk.secrets",
      "operator.approvals",
      "operator.pairing",
      "node.exec",
      "node.display",
      "node.camera",
      "node.voice",
    ],
  });

export function sameDeviceBootstrapProfile(
  left: DeviceBootstrapProfile,
  right: DeviceBootstrapProfile,
): boolean {
  return (
    left.roles.length === right.roles.length &&
    left.scopes.length === right.scopes.length &&
    left.roles.every((value, index) => value === right.roles[index]) &&
    left.scopes.every((value, index) => value === right.scopes[index])
  );
}

/**
 * Checks if the requested profile is satisfied by the allowed profile.
 * A requested profile is satisfied if all its roles and scopes are present in the allowed profile.
 */
export function satisfiesDeviceBootstrapProfile(
  requested: DeviceBootstrapProfile,
  allowed: DeviceBootstrapProfile,
): boolean {
  if (requested.roles.length === 0) {
    return false;
  }
  const rolesMatch = requested.roles.every((role) => allowed.roles.includes(role));
  if (!rolesMatch) {
    return false;
  }

  // Scopes must be permitted under at least one of the requested roles
  // (usually there is only one role requested during verification).
  const scopesMatch = requested.roles.some((role) =>
    roleScopesAllow({
      role,
      requestedScopes: requested.scopes,
      allowedScopes: allowed.scopes,
    }),
  );

  // If no scopes are requested, scopesMatch will be true.
  // If multiple roles are requested, and some scopes are 'operator' scopes and some are 'node' scopes,
  // roleScopesAllow requires that ALL requested scopes be valid for the GIVEN role.
  // To support multi-role requests requesting a mix of scopes, we must fall back to basic inclusion
  // if `roleScopesAllow` fails, because `roleScopesAllow` enforces prefix checking (e.g. `operator.` for operator).
  return scopesMatch || requested.scopes.every((scope) => allowed.scopes.includes(scope));
}
