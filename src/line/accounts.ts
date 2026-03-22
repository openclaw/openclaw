import {
  listCombinedAccountIds,
  resolveListedDefaultAccountId,
} from "../channels/plugins/account-helpers.js";
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

export function resolveLineAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedLineAccount {
  const cfg = params.cfg;
  const accountId = normalizeSharedAccountId(params.accountId);
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  const accounts = lineConfig?.accounts;
  const accountConfig =
    accountId !== DEFAULT_ACCOUNT_ID ? resolveAccountEntry(accounts, accountId) : undefined;

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

  const {
    accounts: _ignoredAccounts,
    defaultAccount: _ignoredDefaultAccount,
    ...lineBase
  } = (lineConfig ?? {}) as LineConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const mergedConfig: LineConfig & LineAccountConfig = {
    ...lineBase,
    ...accountConfig,
  };

  const enabled =
    accountConfig?.enabled ??
    (accountId === DEFAULT_ACCOUNT_ID ? (lineConfig?.enabled ?? true) : false);

  const name =
    accountConfig?.name ?? (accountId === DEFAULT_ACCOUNT_ID ? lineConfig?.name : undefined);

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
  const hasBaseCredentials = Boolean(
    lineConfig?.channelAccessToken?.trim() ||
    lineConfig?.tokenFile ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim(),
  );
  const preferred = normalizeOptionalAccountId(lineConfig?.defaultAccount);
  const configuredAccountIds = [
    ...new Set(
      Object.keys(lineConfig?.accounts ?? {})
        .filter(Boolean)
        .map(normalizeSharedAccountId),
    ),
  ];
  return listCombinedAccountIds({
    configuredAccountIds,
    implicitAccountId: hasBaseCredentials ? (preferred ?? DEFAULT_ACCOUNT_ID) : undefined,
  });
}

export function resolveDefaultLineAccountId(cfg: OpenClawConfig): string {
  return resolveListedDefaultAccountId({
    accountIds: listLineAccountIds(cfg),
    configuredDefaultAccountId: normalizeOptionalAccountId(
      (cfg.channels?.line as LineConfig | undefined)?.defaultAccount,
    ),
  });
}

export function normalizeAccountId(accountId: string | undefined): string {
  return normalizeSharedAccountId(accountId);
}
