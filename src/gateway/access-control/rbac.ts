/**
 * GovDOSS™ RBAC Framework — Role-Based Access Control
 *
 * Implements CMMC Level 2 / CP-1 (Access Control) with a four-tier role
 * hierarchy: ADMIN > OPERATOR > OBSERVER > GUEST.
 *
 * Design principles (GovDOSS™ / KIS⁴™):
 * - Roles are enumerated; unknown roles default to GUEST (fail-safe).
 * - Permissions are explicit; no implicit inheritance beyond the mapping.
 * - All comparisons are pure functions — no runtime state.
 */

// ---------------------------------------------------------------------------
// Role hierarchy
// ---------------------------------------------------------------------------

export const CMMC_ROLES = ["admin", "operator", "observer", "guest"] as const;
export type CmmcRole = (typeof CMMC_ROLES)[number];

export function parseCmmcRole(raw: unknown): CmmcRole {
  if (raw === "admin" || raw === "operator" || raw === "observer" || raw === "guest") {
    return raw;
  }
  // Fail-safe: unknown roles default to least-privilege guest.
  return "guest";
}

// ---------------------------------------------------------------------------
// Permission catalogue
// ---------------------------------------------------------------------------

export const PERMISSIONS = [
  // Account management
  "account:create",
  "account:disable",
  "account:enable",
  "account:list",
  "account:delete",
  // Session management
  "session:revoke",
  "session:list",
  // Config management
  "config:read",
  "config:write",
  // Audit log access
  "audit:read",
  "audit:export",
  // Gateway operations
  "gateway:restart",
  "gateway:status",
  // Channel management
  "channel:read",
  "channel:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// ---------------------------------------------------------------------------
// Role → Permission mapping
// ---------------------------------------------------------------------------

/**
 * Returns the set of permissions granted to a given role.
 * Higher roles include all permissions of lower roles (explicit enumeration
 * avoids implicit hierarchy bugs).
 */
export function getPermissionsForRole(role: CmmcRole): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

const GUEST_PERMISSIONS: Permission[] = ["gateway:status", "channel:read"];

const OBSERVER_PERMISSIONS: Permission[] = [
  ...GUEST_PERMISSIONS,
  "account:list",
  "session:list",
  "config:read",
  "audit:read",
  "channel:read",
];

const OPERATOR_PERMISSIONS: Permission[] = [
  ...OBSERVER_PERMISSIONS,
  "session:revoke",
  "config:write",
  "audit:export",
  "channel:write",
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...OPERATOR_PERMISSIONS,
  "account:create",
  "account:disable",
  "account:enable",
  "account:delete",
  "gateway:restart",
];

const ROLE_PERMISSIONS: Record<CmmcRole, ReadonlySet<Permission>> = {
  guest: new Set(GUEST_PERMISSIONS),
  observer: new Set(OBSERVER_PERMISSIONS),
  operator: new Set(OPERATOR_PERMISSIONS),
  admin: new Set(ADMIN_PERMISSIONS),
};

// ---------------------------------------------------------------------------
// Role ordering helpers
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<CmmcRole, number> = {
  guest: 0,
  observer: 1,
  operator: 2,
  admin: 3,
};

/** Returns true when `role` meets or exceeds `minimum`. */
export function roleAtLeast(role: CmmcRole, minimum: CmmcRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
