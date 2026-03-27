import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "./device-auth.js";

export type DeviceBootstrapProfile = {
  roles: string[];
  scopes: string[];
};

export type DeviceBootstrapProfileInput = {
  roles?: readonly string[];
  scopes?: readonly string[];
};

export const PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile = {
  roles: ["node", "operator"],
  scopes: [
    "node.camera",
    "node.display",
    "node.exec",
    "node.voice",
    "operator.approvals",
    "operator.pairing",
    "operator.read",
    "operator.talk.secrets",
    "operator.write",
  ],
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
  return (
    requested.roles.every((role) => allowed.roles.includes(role)) &&
    requested.scopes.every((scope) => allowed.scopes.includes(scope))
  );
}
