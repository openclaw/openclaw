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
  scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
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
