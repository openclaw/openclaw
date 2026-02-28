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
    // If the base channel config has its own tokens (botToken/appToken/token),
    // include the default account alongside named accounts so both providers start.
    if (!ids.includes(DEFAULT_ACCOUNT_ID)) {
      const channel = cfg.channels?.[channelKey];
      const base = channel as Record<string, unknown> | undefined;
      const hasBaseTokens = Boolean(base?.botToken || base?.appToken || base?.token);
      if (hasBaseTokens) {
        return [DEFAULT_ACCOUNT_ID, ...ids].toSorted((a, b) => a.localeCompare(b));
      }
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
