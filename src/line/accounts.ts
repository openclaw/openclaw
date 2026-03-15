import type { OpenClawConfig } from "../config/config.js";
import { tryReadSecretFileSync } from "../infra/secret-file.js";
import {
  listConfiguredAccountIds as listConfiguredAccountIdsFromSection,
  resolveAccountWithDefaultFallback,
} from "../plugin-sdk/account-resolution.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId as normalizeSharedAccountId,
  normalizeOptionalAccountId,
} from "../routing/account-id.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import type {
  LineConfig,
  LineAccountConfig,
  ResolvedLineAccount,
  LineTokenSource,
} from "./types.js";

export { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";

type LineMergedConfig = LineConfig & LineAccountConfig;
type LineConfigWithMeta = LineMergedConfig & {
  accounts?: unknown;
  defaultAccount?: unknown;
};

function readFileIfExists(filePath: string | undefined): string | undefined {
  return tryReadSecretFileSync(filePath, "LINE credential file", { rejectSymlink: true });
}

function resolveLineConfig(cfg: OpenClawConfig): LineConfig | undefined {
  return cfg.channels?.line as LineConfig | undefined;
}

function resolveToken(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
}): { token: string; tokenSource: LineTokenSource } {
  const { accountId, baseConfig, accountConfig } = params;

  // Check account-level config first
  if (accountConfig?.channelAccessToken?.trim()) {
    return { token: accountConfig.channelAccessToken.trim(), tokenSource: "config" };
  }

  // Check account-level token file
  const accountFileToken = readFileIfExists(accountConfig?.tokenFile);
  if (accountFileToken) {
    return { token: accountFileToken, tokenSource: "file" };
  }

  // For default account, check base config and env
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.channelAccessToken?.trim()) {
      return { token: baseConfig.channelAccessToken.trim(), tokenSource: "config" };
    }

    const baseFileToken = readFileIfExists(baseConfig?.tokenFile);
    if (baseFileToken) {
      return { token: baseFileToken, tokenSource: "file" };
    }

    const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, tokenSource: "env" };
    }
  }

  return { token: "", tokenSource: "none" };
}

function resolveSecret(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
}): string {
  const { accountId, baseConfig, accountConfig } = params;

  // Check account-level config first
  if (accountConfig?.channelSecret?.trim()) {
    return accountConfig.channelSecret.trim();
  }

  // Check account-level secret file
  const accountFileSecret = readFileIfExists(accountConfig?.secretFile);
  if (accountFileSecret) {
    return accountFileSecret;
  }

  // For default account, check base config and env
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.channelSecret?.trim()) {
      return baseConfig.channelSecret.trim();
    }

    const baseFileSecret = readFileIfExists(baseConfig?.secretFile);
    if (baseFileSecret) {
      return baseFileSecret;
    }

    const envSecret = process.env.LINE_CHANNEL_SECRET?.trim();
    if (envSecret) {
      return envSecret;
    }
  }

  return "";
}

function resolveLineAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): LineAccountConfig | undefined {
  const accounts = resolveLineConfig(cfg)?.accounts;
  const directMatch = resolveAccountEntry(accounts, accountId);
  if (directMatch) {
    return directMatch;
  }
  const matchKey = Object.keys(accounts ?? {}).find(
    (key) => normalizeSharedAccountId(key) === accountId,
  );
  return matchKey ? accounts?.[matchKey] : undefined;
}

function mergeLineAccountConfig(cfg: OpenClawConfig, accountId: string): LineMergedConfig {
  const {
    accounts: _ignoredAccounts,
    defaultAccount: _ignoredDefaultAccount,
    ...lineBase
  } = (resolveLineConfig(cfg) ?? {}) as LineConfigWithMeta;
  const accountConfig = resolveLineAccountConfig(cfg, accountId) ?? {};
  return { ...lineBase, ...accountConfig };
}

function hasLineCredentials(
  account: Pick<ResolvedLineAccount, "channelAccessToken" | "channelSecret">,
): boolean {
  return Boolean(account.channelAccessToken.trim() && account.channelSecret.trim());
}

function resolveLineAccountStrict(cfg: OpenClawConfig, accountId: string): ResolvedLineAccount {
  const lineConfig = resolveLineConfig(cfg);
  const accountConfig = resolveLineAccountConfig(cfg, accountId);
  const mergedConfig = mergeLineAccountConfig(cfg, accountId);

  const { token, tokenSource } = resolveToken({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
  });

  const secret = resolveSecret({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
  });

  const baseEnabled = lineConfig?.enabled !== false;
  const accountEnabled = mergedConfig.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const name = mergedConfig.name?.trim() || undefined;

  return {
    accountId,
    name,
    enabled,
    channelAccessToken: token,
    channelSecret: secret,
    tokenSource,
    config: mergedConfig,
  };
}

export function resolveLineAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedLineAccount {
  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    normalizeAccountId: normalizeSharedAccountId,
    resolvePrimary: (accountId) => resolveLineAccountStrict(params.cfg, accountId),
    hasCredential: hasLineCredentials,
    resolveDefaultAccountId: () => resolveDefaultLineAccountId(params.cfg),
  });
}

export function listLineAccountIds(cfg: OpenClawConfig): string[] {
  const lineConfig = resolveLineConfig(cfg);
  const ids = new Set(
    listConfiguredAccountIdsFromSection({
      accounts: lineConfig?.accounts,
      normalizeAccountId: normalizeSharedAccountId,
    }),
  );

  // Add default account if configured at base level
  if (
    lineConfig?.channelAccessToken?.trim() ||
    lineConfig?.tokenFile ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim()
  ) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultLineAccountId(cfg: OpenClawConfig): string {
  const preferred = normalizeOptionalAccountId(resolveLineConfig(cfg)?.defaultAccount);
  if (
    preferred &&
    listLineAccountIds(cfg).some((accountId) => normalizeSharedAccountId(accountId) === preferred)
  ) {
    return preferred;
  }
  const ids = listLineAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function normalizeAccountId(accountId: string | undefined): string {
  return normalizeSharedAccountId(accountId);
}
