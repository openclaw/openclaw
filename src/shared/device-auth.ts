import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

/** Stored bearer token metadata for one authorized device role. */
export type DeviceAuthEntry = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

/** Versioned browser-local device-auth cache for a gateway device identity. */
export type DeviceAuthStore = {
  version: 1;
  deviceId: string;
  tokens: Record<string, DeviceAuthEntry>;
};

/** Normalize a device-auth role id without changing its case or namespace. */
export function normalizeDeviceAuthRole(role: string): string {
  return role.trim();
}

/** Normalize device-auth scopes, dedupe/sort them, and include implied operator scopes. */
export function normalizeDeviceAuthScopes(scopes: readonly unknown[] | undefined): string[] {
  const out = new Set(normalizeTrimmedStringList(scopes));
  // Operator scope implication keeps older approval checks working with broader grants.
  if (out.has("operator.admin")) {
    out.add("operator.read");
    out.add("operator.write");
  } else if (out.has("operator.write")) {
    out.add("operator.read");
  }
  return [...out].toSorted();
}
