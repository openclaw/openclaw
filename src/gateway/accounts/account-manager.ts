/**
 * AccountManager — GovDOSS™ account lifecycle management.
 *
 * Implements CMMC CP-2 controls:
 * - Account creation with RBAC validation
 * - Account disable/enable with audit trail
 * - Account listing with role-based filtering
 * - Password update with history enforcement
 *
 * All mutating operations accept an `actor` string for SOA⁴™ attribution.
 */

import { randomUUID } from "node:crypto";
import { AccessController } from "../access-control/access-controller.js";
import type { CmmcRole } from "../access-control/rbac.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "../auth/password-policy.js";
import type { Account, AccountStatus, CreateAccountInput, UpdateAccountInput } from "./account.js";

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

const PASSWORD_HISTORY_LIMIT = 5;

export class AccountManager {
  /** In-memory store; replace with a persistent store in production. */
  private readonly accounts = new Map<string, Account>();

  // ---------------------------------------------------------------------------
  // Account creation
  // ---------------------------------------------------------------------------

  /**
   * Creates a new account. The actor must have `account:create` permission.
   * Enforces password policy and initialises audit fields.
   */
  async create(input: CreateAccountInput, actor: AccessController): Promise<Account> {
    actor.assert("account:create");

    const validation = validatePasswordStrength(input.password);
    if (!validation.valid) {
      throw new AccountError(
        `Password does not meet policy: ${validation.errors.join(", ")}`,
        "WEAK_PASSWORD",
      );
    }

    if (this.findByUsername(input.username)) {
      throw new AccountError(`Account '${input.username}' already exists`, "DUPLICATE_USERNAME");
    }

    const passwordHash = await hashPassword(input.password);
    const now = new Date().toISOString();

    const account: Account = {
      id: randomUUID(),
      username: input.username,
      role: input.role,
      status: "active",
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
      passwordHash,
      passwordHistory: [],
      requireMfa: input.requireMfa ?? true,
    };

    this.accounts.set(account.id, account);
    return account;
  }

  // ---------------------------------------------------------------------------
  // Account disable / enable
  // ---------------------------------------------------------------------------

  /** Disables an account. Actor must have `account:disable` permission. */
  async disable(id: string, actor: AccessController): Promise<Account> {
    actor.assert("account:disable");
    const account = this.requireAccount(id);

    if (account.status === "disabled") {
      throw new AccountError(`Account '${id}' is already disabled`, "ALREADY_DISABLED");
    }

    const now = new Date().toISOString();
    const updated: Account = {
      ...account,
      status: "disabled",
      disabledAt: now,
      updatedAt: now,
      updatedBy: actor.role,
    };
    this.accounts.set(id, updated);
    return updated;
  }

  /** Re-enables a disabled account. Actor must have `account:enable` permission. */
  async enable(id: string, actor: AccessController): Promise<Account> {
    actor.assert("account:enable");
    const account = this.requireAccount(id);

    if (account.status === "active") {
      throw new AccountError(`Account '${id}' is already active`, "ALREADY_ACTIVE");
    }

    const now = new Date().toISOString();
    const updated: Account = {
      ...account,
      status: "active",
      disabledAt: null,
      updatedAt: now,
      updatedBy: actor.role,
    };
    this.accounts.set(id, updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Account listing
  // ---------------------------------------------------------------------------

  /**
   * Lists accounts, optionally filtered by role or status.
   * Actor must have `account:list` permission.
   */
  list(actor: AccessController, filter?: { role?: CmmcRole; status?: AccountStatus }): Account[] {
    actor.assert("account:list");
    let results = Array.from(this.accounts.values());

    if (filter?.role) {
      results = results.filter((a) => a.role === filter.role);
    }
    if (filter?.status) {
      results = results.filter((a) => a.status === filter.status);
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Account retrieval
  // ---------------------------------------------------------------------------

  /** Returns an account by id, or null. Actor must have `account:list`. */
  get(id: string, actor: AccessController): Account | null {
    actor.assert("account:list");
    return this.accounts.get(id) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Password update
  // ---------------------------------------------------------------------------

  /**
   * Updates the password, enforcing history (last N hashes).
   * The current password must be provided for verification.
   */
  async changePassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const account = this.requireAccount(id);

    const currentValid = await verifyPassword(currentPassword, account.passwordHash);
    if (!currentValid) {
      throw new AccountError("Current password is incorrect", "INVALID_PASSWORD");
    }

    const validation = validatePasswordStrength(newPassword);
    if (!validation.valid) {
      throw new AccountError(
        `New password does not meet policy: ${validation.errors.join(", ")}`,
        "WEAK_PASSWORD",
      );
    }

    // Check password history to prevent reuse.
    for (const oldHash of account.passwordHistory) {
      const reused = await verifyPassword(newPassword, oldHash);
      if (reused) {
        throw new AccountError(
          `Password was used recently; choose a different password`,
          "PASSWORD_REUSE",
        );
      }
    }

    const newHash = await hashPassword(newPassword);
    const history = [account.passwordHash, ...account.passwordHistory].slice(
      0,
      PASSWORD_HISTORY_LIMIT,
    );

    const updated: Account = {
      ...account,
      passwordHash: newHash,
      passwordHistory: history,
      updatedAt: new Date().toISOString(),
    };
    this.accounts.set(id, updated);
  }

  // ---------------------------------------------------------------------------
  // Account update
  // ---------------------------------------------------------------------------

  /** Updates account metadata. Actor must have `account:enable` or `account:create`. */
  update(id: string, input: UpdateAccountInput, actor: AccessController): Account {
    actor.assert("account:create");
    const account = this.requireAccount(id);

    const updated: Account = {
      ...account,
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.requireMfa !== undefined ? { requireMfa: input.requireMfa } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: input.updatedBy,
    };
    this.accounts.set(id, updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Account deletion
  // ---------------------------------------------------------------------------

  /** Permanently deletes an account. Actor must have `account:delete`. */
  delete(id: string, actor: AccessController): void {
    actor.assert("account:delete");
    this.requireAccount(id);
    this.accounts.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private requireAccount(id: string): Account {
    const account = this.accounts.get(id);
    if (!account) {
      throw new AccountError(`Account '${id}' not found`, "NOT_FOUND");
    }
    return account;
  }

  private findByUsername(username: string): Account | undefined {
    for (const account of this.accounts.values()) {
      if (account.username === username) {
        return account;
      }
    }
    return undefined;
  }
}
