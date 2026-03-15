import type { OpenClawConfig } from "../config/config.js";
import { tryReadSecretFileSync } from "../infra/secret-file.js";
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

function readFileIfExists(filePath: string | undefined): string | undefined {
  return tryReadSecretFileSync(filePath, "LINE credential file", { rejectSymlink: true });
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
  return resolveAccountEntry((cfg.channels?.line as LineConfig | undefined)?.accounts, accountId);
}

function mergeLineAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): LineConfig & LineAccountConfig {
  const {
    accounts: _ignoredAccounts,
    defaultAccount: _ignoredDefaultAccount,
    ...lineBase
  } = (cfg.channels?.line ?? {}) as LineConfig &
    LineAccountConfig & {
      accounts?: unknown;
      defaultAccount?: unknown;
    };
  const accountConfig = resolveLineAccountConfig(cfg, accountId) ?? {};
  return { ...lineBase, ...accountConfig };
}

export function resolveLineAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedLineAccount {
  const cfg = params.cfg;
  const accountId = normalizeSharedAccountId(params.accountId);
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
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

export function listLineAccountIds(cfg: OpenClawConfig): string[] {
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  const accounts = lineConfig?.accounts;
  const ids = new Set<string>();

  // Add default account if configured at base level
  if (
    lineConfig?.channelAccessToken?.trim() ||
    lineConfig?.tokenFile ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim()
  ) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  // Add named accounts
  if (accounts) {
    for (const id of Object.keys(accounts)) {
      ids.add(id);
    }
  }

  return Array.from(ids);
}

export function resolveDefaultLineAccountId(cfg: OpenClawConfig): string {
  const preferred = normalizeOptionalAccountId(
    (cfg.channels?.line as LineConfig | undefined)?.defaultAccount,
  );
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
