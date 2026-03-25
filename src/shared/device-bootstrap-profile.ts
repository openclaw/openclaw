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
  roles: ["node"],
  scopes: [],
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
