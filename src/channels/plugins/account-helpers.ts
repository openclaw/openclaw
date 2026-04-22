import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAccountEntry,
  resolveNormalizedAccountEntry,
} from "../../routing/account-lookup.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { ChannelAccountSnapshot } from "./types.core.js";

export function createAccountListHelpers(
  channelKey: string,
  options?: {
    normalizeAccountId?: (id: string) => string;
    allowUnlistedDefaultAccount?: boolean;
  },
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
    if (options?.allowUnlistedDefaultAccount) {
      return preferred;
    }
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
    // If the base channel config has its own tokens (botToken/appToken/token),
    // include the default account alongside named accounts so both providers start —
    // but only when at least one named account carries its own per-account auth.
    // When every named account inherits the base tokens, injecting default would
    // start a duplicate provider on the same credentials.
    const configuredIds = listConfiguredAccountIds(cfg);
    const channel = cfg.channels?.[channelKey];
    const base = channel as Record<string, unknown> | undefined;
    const isTruthy = (v: unknown): boolean =>
      typeof v === "string" ? v.trim().length > 0 : Boolean(v);
    const baseTokenFields = (["botToken", "appToken", "token"] as const).filter((f) =>
      isTruthy(base?.[f]),
    );

    let implicitId: string | undefined;
    if (baseTokenFields.length > 0 && configuredIds.length > 0) {
      const accounts = (base?.accounts ?? {}) as Record<string, Record<string, unknown>>;
      const normalizeId = options?.normalizeAccountId ?? normalizeAccountId;
      const normalizedToRaw = new Map<string, string>();
      for (const key of Object.keys(accounts)) {
        const normalized = normalizeId(key);
        if (normalized && !normalizedToRaw.has(normalized)) {
          normalizedToRaw.set(normalized, key);
        }
      }
      const enabledIds = configuredIds.filter((id) => {
        const rawKey = normalizedToRaw.get(id) ?? id;
        const acct = accounts[rawKey];
        return !acct || acct["enabled"] !== false;
      });
      const everyAccountHasOwnTokens =
        enabledIds.length > 0 &&
        enabledIds.every((id) => {
          const rawKey = normalizedToRaw.get(id) ?? id;
          const acct = accounts[rawKey];
          if (!acct) {
            return false;
          }
          return baseTokenFields.every((f) => isTruthy(acct[f]));
        });
      if (everyAccountHasOwnTokens) {
        // Only inject implicit default if no configured account already normalizes to "default"
        const alreadyHasDefault = configuredIds.some(
          (id) => normalizeId(id) === DEFAULT_ACCOUNT_ID,
        );
        if (!alreadyHasDefault) {
          implicitId = DEFAULT_ACCOUNT_ID;
        }
      }
    }

    return listCombinedAccountIds({
      configuredAccountIds: configuredIds,
      implicitAccountId: implicitId,
      fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
    });
  }

  function resolveDefaultAccountId(cfg: OpenClawConfig): string {
    return resolveListedDefaultAccountId({
      accountIds: listAccountIds(cfg),
      configuredDefaultAccountId: resolveConfiguredDefaultAccountId(cfg),
      allowUnlistedDefaultAccount: options?.allowUnlistedDefaultAccount,
    });
  }

  return { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId };
}

export function listCombinedAccountIds(params: {
  configuredAccountIds: Iterable<string>;
  additionalAccountIds?: Iterable<string>;
  implicitAccountId?: string | undefined;
  fallbackAccountIdWhenEmpty?: string | undefined;
}): string[] {
  const ids = new Set<string>();

  for (const id of params.configuredAccountIds) {
    if (id) {
      ids.add(id);
    }
  }
  for (const id of params.additionalAccountIds ?? []) {
    if (id) {
      ids.add(id);
    }
  }
  if (params.implicitAccountId) {
    ids.add(params.implicitAccountId);
  }

  if (ids.size === 0 && params.fallbackAccountIdWhenEmpty) {
    return [params.fallbackAccountIdWhenEmpty];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function resolveListedDefaultAccountId(params: {
  accountIds: readonly string[];
  configuredDefaultAccountId?: string | undefined;
  allowUnlistedDefaultAccount?: boolean;
  ambiguousFallbackAccountId?: string | undefined;
  normalizeListedAccountId?: ((accountId: string) => string) | undefined;
}): string {
  const preferred = params.configuredDefaultAccountId;
  const normalizeListedAccountId = params.normalizeListedAccountId ?? normalizeAccountId;
  if (
    preferred &&
    (params.allowUnlistedDefaultAccount ||
      params.accountIds.some((accountId) => normalizeListedAccountId(accountId) === preferred))
  ) {
    return preferred;
  }
  if (params.accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (params.ambiguousFallbackAccountId && params.accountIds.length > 1) {
    return params.ambiguousFallbackAccountId;
  }
  return params.accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

export function mergeAccountConfig<TConfig extends Record<string, unknown>>(params: {
  channelConfig: TConfig | undefined;
  accountConfig: Partial<TConfig> | undefined;
  omitKeys?: string[];
  nestedObjectKeys?: string[];
}): TConfig {
  const omitKeys = new Set(["accounts", ...(params.omitKeys ?? [])]);
  const base = Object.fromEntries(
    Object.entries((params.channelConfig ?? {}) as Record<string, unknown>).filter(
      ([key]) => !omitKeys.has(key),
    ),
  ) as TConfig;
  const merged = {
    ...base,
    ...params.accountConfig,
  };
  for (const key of params.nestedObjectKeys ?? []) {
    const baseValue = base[key as keyof TConfig];
    const accountValue = params.accountConfig?.[key as keyof TConfig];
    if (
      typeof baseValue === "object" &&
      baseValue != null &&
      !Array.isArray(baseValue) &&
      typeof accountValue === "object" &&
      accountValue != null &&
      !Array.isArray(accountValue)
    ) {
      (merged as Record<string, unknown>)[key] = {
        ...(baseValue as Record<string, unknown>),
        ...(accountValue as Record<string, unknown>),
      };
    }
  }
  return merged;
}

export function resolveMergedAccountConfig<TConfig extends Record<string, unknown>>(params: {
  channelConfig: TConfig | undefined;
  accounts: Record<string, Partial<TConfig>> | undefined;
  accountId: string;
  omitKeys?: string[];
  normalizeAccountId?: (accountId: string) => string;
  nestedObjectKeys?: string[];
}): TConfig {
  const accountConfig = params.normalizeAccountId
    ? resolveNormalizedAccountEntry(params.accounts, params.accountId, params.normalizeAccountId)
    : resolveAccountEntry(params.accounts, params.accountId);
  return mergeAccountConfig<TConfig>({
    channelConfig: params.channelConfig,
    accountConfig,
    omitKeys: params.omitKeys,
    nestedObjectKeys: params.nestedObjectKeys,
  });
}

type AccountSnapshotInput = {
  accountId?: string | null;
  enabled?: boolean | null;
  name?: string | null | undefined;
};

export function describeAccountSnapshot(params: {
  account: AccountSnapshotInput;
  configured?: boolean | undefined;
  extra?: Record<string, unknown> | undefined;
}): ChannelAccountSnapshot {
  return {
    accountId: params.account.accountId ?? DEFAULT_ACCOUNT_ID,
    name: normalizeOptionalString(params.account.name),
    enabled: params.account.enabled !== false,
    configured: params.configured,
    ...params.extra,
  };
}

export function describeWebhookAccountSnapshot(params: {
  account: AccountSnapshotInput;
  configured?: boolean | undefined;
  mode?: string | undefined;
  extra?: Record<string, unknown> | undefined;
}): ChannelAccountSnapshot {
  return describeAccountSnapshot({
    account: params.account,
    configured: params.configured,
    extra: {
      mode: params.mode ?? "webhook",
      ...params.extra,
    },
  });
}
