import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";

export function createAccountListHelpers(
  channelKey: string,
  options?: { normalizeAccountId?: (id: string) => string },
) {
  function resolveConfiguredDefaultAccountId(cfg: OpenClawConfig): string | undefined {
    const channel = cfg.channels?.[channelKey] as Record<string, unknown> | undefined;
    const preferred = normalizeOptionalAccountId(
      typeof channel?.defaultAccount === "string" ? channel.defaultAccount : undefined,
    );
    if (!preferred) {
      return undefined;
    }
    const ids = listAccountIds(cfg);
    if (ids.some((id) => normalizeAccountId(id) === preferred)) {
      return preferred;
    }
    return undefined;
  }

  function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
    const channel = cfg.channels?.[channelKey];
    const accounts = (channel as Record<string, unknown> | undefined)?.accounts;
    if (!accounts || typeof accounts !== "object") {
      return [];
    }
    const ids = Object.keys(accounts as Record<string, unknown>).filter(Boolean);
    const normalizeConfiguredAccountId = options?.normalizeAccountId;
    if (!normalizeConfiguredAccountId) {
      return ids;
    }
    return [...new Set(ids.map((id) => normalizeConfiguredAccountId(id)).filter(Boolean))];
  }

  function listAccountIds(cfg: OpenClawConfig): string[] {
    const ids = listConfiguredAccountIds(cfg);
    if (ids.length === 0) {
      return [DEFAULT_ACCOUNT_ID];
    }
    // Check whether any existing named account already normalizes to "default".
    const normalizedIds = ids.map(normalizeAccountId);
    if (normalizedIds.includes(DEFAULT_ACCOUNT_ID)) {
      return ids.toSorted((a, b) => a.localeCompare(b));
    }
    // If the base channel config has its own tokens (botToken/appToken/token),
    // only inject a default account when at least one named account carries its
    // own per-account auth.  When every named account inherits the base tokens
    // (i.e. has no per-account botToken/appToken/token override), injecting
    // default would start a duplicate provider on the same credentials.
    const channel = cfg.channels?.[channelKey];
    const base = channel as Record<string, unknown> | undefined;
    const hasBaseTokens = Boolean(base?.botToken || base?.appToken || base?.token);
    if (hasBaseTokens) {
      const accounts = (base?.accounts ?? {}) as Record<string, Record<string, unknown>>;
      const someAccountHasOwnTokens = ids.some((id) => {
        const acct = accounts[id];
        return acct && Boolean(acct.botToken || acct.appToken || acct.token);
      });
      if (someAccountHasOwnTokens) {
        return [DEFAULT_ACCOUNT_ID, ...ids].toSorted((a, b) => a.localeCompare(b));
      }
      // All named accounts inherit base tokens — don't inject default.
    }
    return ids.toSorted((a, b) => a.localeCompare(b));
  }

  function resolveDefaultAccountId(cfg: OpenClawConfig): string {
    const preferred = resolveConfiguredDefaultAccountId(cfg);
    if (preferred) {
      return preferred;
    }
    const ids = listAccountIds(cfg);
    if (ids.includes(DEFAULT_ACCOUNT_ID)) {
      return DEFAULT_ACCOUNT_ID;
    }
    return ids[0] ?? DEFAULT_ACCOUNT_ID;
  }

  return { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId };
}
