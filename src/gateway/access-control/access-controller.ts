/**
 * AccessController — per-request permission enforcement.
 *
 * Wraps a caller's role and provides a single `check` method that throws
 * (or returns false) when the caller lacks a required permission.
 *
 * CMMC CP-1: all permission checks are auditable via the caller's role.
 */

import { getPermissionsForRole, parseCmmcRole, type CmmcRole, type Permission } from "./rbac.js";

export class AccessDeniedError extends Error {
  readonly role: CmmcRole;
  readonly permission: Permission;

  constructor(role: CmmcRole, permission: Permission) {
    super(`Access denied: role '${role}' lacks permission '${permission}'`);
    this.name = "AccessDeniedError";
    this.role = role;
    this.permission = permission;
  }
}

export class AccessController {
  readonly role: CmmcRole;

  constructor(role: unknown) {
    this.role = parseCmmcRole(role);
  }

  /** Returns true when the caller has the given permission. */
  has(permission: Permission): boolean {
    return getPermissionsForRole(this.role).has(permission);
  }

  /**
   * Asserts the caller has the given permission.
   * Throws `AccessDeniedError` otherwise (fail-closed).
   */
  assert(permission: Permission): void {
    if (!this.has(permission)) {
      throw new AccessDeniedError(this.role, permission);
    }
  }

  /**
   * Checks the permission and returns a typed result instead of throwing.
   * Useful when the caller wants to branch rather than catch.
   */
  check(permission: Permission): { ok: true } | { ok: false; reason: string } {
    if (this.has(permission)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `Role '${this.role}' does not have permission '${permission}'`,
    };
  }
}

/** Convenience factory that parses the role from an untrusted source. */
export function createAccessController(role: unknown): AccessController {
  return new AccessController(role);
}
