import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";

export function createAccountListHelpers(channelKey: string) {
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
    return Object.keys(accounts as Record<string, unknown>).filter(Boolean);
  }

  function listAccountIds(cfg: OpenClawConfig): string[] {
    const ids = listConfiguredAccountIds(cfg);
    if (ids.length === 0) {
      return [DEFAULT_ACCOUNT_ID];
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
