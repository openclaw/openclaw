/** Stored bearer token metadata for one authorized device role. */
export type DeviceAuthEntry = {
  /** Opaque bearer token persisted for this role. */
  token: string;
  /** Normalized role key, such as `node` or `operator`. */
  role: string;
  /** Canonical sorted scopes, including implied operator scopes. */
  scopes: string[];
  /** Wall-clock update time used for diagnostics and token freshness display. */
  updatedAtMs: number;
};

/** Versioned on-disk device-auth cache for a gateway device identity. */
export type DeviceAuthStore = {
  /** Store schema version; incompatible versions are ignored instead of migrated here. */
  version: 1;
  /** Gateway device id this token cache is bound to. */
  deviceId: string;
  /** Role-keyed token entries for the bound gateway device id. */
  tokens: Record<string, DeviceAuthEntry>;
};

/** Normalize a device-auth role id without changing its case or namespace. */
export function normalizeDeviceAuthRole(role: string): string {
  return role.trim();
}

/** Normalize device-auth scopes, dedupe/sort them, and include implied operator scopes. */
export function normalizeDeviceAuthScopes(scopes: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(scopes)) {
    return [];
  }
  const out = new Set<string>();
  for (const scope of scopes) {
    if (typeof scope !== "string") {
      continue;
    }
    const trimmed = scope.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }
  // Operator scope implication keeps older approval checks working with broader grants.
  if (out.has("operator.admin")) {
    out.add("operator.read");
    out.add("operator.write");
  } else if (out.has("operator.write")) {
    out.add("operator.read");
  }
  return [...out].toSorted();
}
