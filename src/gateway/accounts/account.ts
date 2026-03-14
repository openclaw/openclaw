/**
 * Account entity — data model for GovDOSS™ account lifecycle.
 *
 * CMMC CP-2: account records include creation, modification, and disable
 * timestamps so the full lifecycle is auditable.
 */

import type { CmmcRole } from "../access-control/rbac.js";

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

export const ACCOUNT_STATUSES = ["active", "disabled", "locked"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Account entity
// ---------------------------------------------------------------------------

export type Account = {
  /** Unique, immutable identifier. */
  id: string;
  /** Human-readable login name. */
  username: string;
  /** RBAC role governing what the account may do. */
  role: CmmcRole;
  /** Lifecycle state. */
  status: AccountStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-modified timestamp. */
  updatedAt: string;
  /** ISO-8601 timestamp when the account was disabled (null if active). */
  disabledAt: string | null;
  /** Actor who created this account (GovDOSS™ SOA⁴™ Subject). */
  createdBy: string;
  /** Actor who last modified this account. */
  updatedBy: string;
  /** Scrypt-derived password hash. */
  passwordHash: string;
  /** Last N password hashes for reuse prevention. */
  passwordHistory: string[];
  /** Require multi-factor authentication (secure-by-default). */
  requireMfa: boolean;
};

// ---------------------------------------------------------------------------
// Account creation input
// ---------------------------------------------------------------------------

export type CreateAccountInput = {
  username: string;
  role: CmmcRole;
  password: string;
  createdBy: string;
  requireMfa?: boolean;
};

// ---------------------------------------------------------------------------
// Account update input
// ---------------------------------------------------------------------------

export type UpdateAccountInput = {
  role?: CmmcRole;
  requireMfa?: boolean;
  updatedBy: string;
};
