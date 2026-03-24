"use strict";

const DEFAULT_ACCOUNT_ID = "default";

function normalizeAccountId(accountId) {
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : DEFAULT_ACCOUNT_ID;
}

function normalizeOptionalAccountId(accountId) {
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function resolveUserPath(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

function resolveAccountEntry(accounts, accountId) {
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function resolveNormalizedAccountEntry(accounts, accountId, normalizer = normalizeAccountId) {
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const normalizedAccountId = normalizer(accountId);
  for (const [key, value] of Object.entries(accounts)) {
    if (normalizer(key) === normalizedAccountId) {
      return value;
    }
  }
  return undefined;
}

function resolveMergedAccountConfig(baseConfig, overrideConfig) {
  return {
    ...(baseConfig && typeof baseConfig === "object" ? baseConfig : {}),
    ...(overrideConfig && typeof overrideConfig === "object" ? overrideConfig : {}),
  };
}

function listConfiguredAccountIds(params) {
  if (!params?.accounts || typeof params.accounts !== "object") {
    return [];
  }
  const normalizer = params.normalizeAccountId ?? normalizeAccountId;
  return [...new Set(Object.keys(params.accounts).map((accountId) => normalizer(accountId)))];
}

function listCombinedAccountIds(params) {
  const combined = new Set([
    ...(params?.configuredAccountIds ?? []),
    ...(params?.additionalAccountIds ?? []),
  ]);
  if (combined.size === 0 && params?.fallbackAccountIdWhenEmpty) {
    combined.add(params.fallbackAccountIdWhenEmpty);
  }
  return [...combined];
}

function resolveListedDefaultAccountId(params) {
  if (
    params?.configuredDefaultAccountId &&
    params.accountIds?.includes(params.configuredDefaultAccountId)
  ) {
    return params.configuredDefaultAccountId;
  }
  if (params?.accountIds?.length === 1) {
    return params.accountIds[0];
  }
  return params?.ambiguousFallbackAccountId ?? params?.accountIds?.[0] ?? DEFAULT_ACCOUNT_ID;
}

function createAccountListHelpers(channel) {
  function getAccounts(cfg) {
    const channelConfig =
      cfg && typeof cfg === "object" && cfg.channels && typeof cfg.channels === "object"
        ? cfg.channels[channel]
        : undefined;
    const accounts =
      channelConfig && typeof channelConfig === "object" ? channelConfig.accounts : undefined;
    return accounts && typeof accounts === "object" ? accounts : undefined;
  }

  return {
    listConfiguredAccountIds(cfg) {
      return listConfiguredAccountIds({
        accounts: getAccounts(cfg),
        normalizeAccountId,
      });
    },
    listAccountIds(cfg) {
      return listConfiguredAccountIds({
        accounts: getAccounts(cfg),
        normalizeAccountId,
      });
    },
    resolveDefaultAccountId(cfg) {
      const channelConfig =
        cfg && typeof cfg === "object" && cfg.channels && typeof cfg.channels === "object"
          ? cfg.channels[channel]
          : undefined;
      const configuredDefault =
        channelConfig &&
        typeof channelConfig === "object" &&
        typeof channelConfig.defaultAccount === "string"
          ? normalizeOptionalAccountId(channelConfig.defaultAccount)
          : undefined;
      return (
        configuredDefault ??
        listConfiguredAccountIds({
          accounts: getAccounts(cfg),
          normalizeAccountId,
        })[0] ??
        DEFAULT_ACCOUNT_ID
      );
    },
  };
}

module.exports = {
  __esModule: true,
  DEFAULT_ACCOUNT_ID,
  createAccountListHelpers,
  listCombinedAccountIds,
  listConfiguredAccountIds,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveAccountEntry,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
  resolveNormalizedAccountEntry,
  resolveUserPath,
};
