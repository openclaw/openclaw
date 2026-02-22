/**
 * CredentialStore — the core of the Credential Firewall.
 *
 * Resolves credentials ONLY when domain pinning and selector checks pass.
 * The resolved value is returned to the caller (the fill_credential tool)
 * but NEVER exposed to the LLM agent context.
 *
 * Works with any SecretsProvider backend (Bitwarden, keyring, 1Password,
 * GCP, AWS, Azure, Vault, age/sops, env vars, or plain text).
 *
 * See: https://github.com/openclaw/openclaw/issues/18245
 */

import { isDomainAllowed, isSelectorAllowed } from "./domain-match.js";
import type { CredentialEntry, CredentialStoreConfig, CredentialUseRecord } from "./types.js";

export type SecretResolver = (source: string) => Promise<string>;

export class CredentialFirewallError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "SLOT_NOT_FOUND"
      | "DOMAIN_BLOCKED"
      | "SELECTOR_BLOCKED"
      | "EXPIRED"
      | "RESOLVE_FAILED",
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CredentialFirewallError";
  }
}

const MAX_AUDIT_LOG_SIZE = 1000;

export class CredentialStore {
  private readonly entries: Map<string, CredentialEntry>;
  private readonly resolveSecret: SecretResolver;
  private readonly auditLog: CredentialUseRecord[] = [];

  constructor(config: CredentialStoreConfig, resolveSecret: SecretResolver) {
    this.entries = new Map();
    this.resolveSecret = resolveSecret;

    for (const entry of config.credentials ?? []) {
      if (entry.slot?.trim() && entry.source && entry.pinnedDomains?.length) {
        this.entries.set(entry.slot, entry);
      }
    }
  }

  /**
   * Resolve a credential value after passing all firewall checks.
   *
   * The returned value must NEVER be exposed to the LLM context.
   * It should only be passed directly to Playwright's fill() method.
   */
  async resolve(params: {
    slot: string;
    currentUrl: string;
    selector: string;
    /** Which field to fill: "password" (default), "username", or "totp". */
    field?: "password" | "username" | "totp";
  }): Promise<string> {
    const { slot, currentUrl, selector, field = "password" } = params;

    const entry = this.entries.get(slot);
    if (!entry) {
      this.recordUse(slot, currentUrl, selector, false, "slot not found");
      throw new CredentialFirewallError(`Credential slot "${slot}" not found.`, "SLOT_NOT_FOUND", {
        slot,
        availableSlots: this.listSlots(),
      });
    }

    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) {
      this.recordUse(slot, currentUrl, selector, false, "expired");
      throw new CredentialFirewallError(
        `Credential "${slot}" has expired (${entry.expiresAt}).`,
        "EXPIRED",
        {
          slot,
          expiresAt: entry.expiresAt,
        },
      );
    }

    const domainCheck = isDomainAllowed(currentUrl, entry.pinnedDomains);
    if (!domainCheck.allowed) {
      this.recordUse(
        slot,
        domainCheck.hostname,
        selector,
        false,
        `domain "${domainCheck.hostname}" not in pinned list`,
      );
      throw new CredentialFirewallError(
        `Domain "${domainCheck.hostname}" is not authorized for credential "${slot}". Allowed: ${entry.pinnedDomains.join(", ")}`,
        "DOMAIN_BLOCKED",
        { slot, hostname: domainCheck.hostname, pinnedDomains: entry.pinnedDomains },
      );
    }

    if (!isSelectorAllowed(selector, entry.allowedSelectors)) {
      this.recordUse(
        slot,
        domainCheck.hostname,
        selector,
        false,
        `selector "${selector}" not allowed`,
      );
      throw new CredentialFirewallError(
        `Selector "${selector}" is not authorized for credential "${slot}". Allowed: ${(entry.allowedSelectors ?? []).join(", ")}`,
        "SELECTOR_BLOCKED",
        { slot, selector, allowedSelectors: entry.allowedSelectors },
      );
    }

    const source = this.pickSource(entry, field);
    if (!source) {
      this.recordUse(slot, domainCheck.hostname, selector, false, `no ${field} source configured`);
      throw new CredentialFirewallError(
        `Credential "${slot}" has no ${field} source configured.`,
        "RESOLVE_FAILED",
        { slot, field },
      );
    }

    let value: string;
    try {
      value = await this.resolveSecret(source);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordUse(slot, domainCheck.hostname, selector, false, `resolve failed: ${msg}`);
      throw new CredentialFirewallError(
        `Failed to resolve credential "${slot}": ${msg}`,
        "RESOLVE_FAILED",
        { slot },
      );
    }

    this.recordUse(slot, domainCheck.hostname, selector, true);
    return value;
  }

  getEntry(slot: string): CredentialEntry | undefined {
    return this.entries.get(slot);
  }

  listSlots(): string[] {
    return Array.from(this.entries.keys());
  }

  getAuditLog(): readonly CredentialUseRecord[] {
    return this.auditLog;
  }

  private pickSource(
    entry: CredentialEntry,
    field: "password" | "username" | "totp",
  ): string | undefined {
    switch (field) {
      case "password":
        return entry.source;
      case "username":
        return entry.usernameSource;
      case "totp":
        return entry.totpSource;
    }
  }

  private recordUse(
    slot: string,
    domain: string,
    selector: string,
    allowed: boolean,
    reason?: string,
  ): void {
    if (this.auditLog.length >= MAX_AUDIT_LOG_SIZE) {
      this.auditLog.shift();
    }
    this.auditLog.push({
      slot,
      domain,
      selector,
      timestamp: new Date().toISOString(),
      allowed,
      reason,
    });
  }
}
