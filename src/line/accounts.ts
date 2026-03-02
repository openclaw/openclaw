import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigPath } from "../config/paths.js";
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

function readFileIfExists(
  filePath: string | undefined,
  configDir: string | undefined,
): string | undefined {
  if (!filePath) {
    return undefined;
  }
  // Resolve relative paths against the config file directory so that
  // `tokenFile: ./token.txt` works regardless of the process working directory.
  const resolvedPath =
    configDir && !path.isAbsolute(filePath) ? path.resolve(configDir, filePath) : filePath;
  try {
    return fs.readFileSync(resolvedPath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

function resolveToken(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
  configDir: string | undefined;
}): { token: string; tokenSource: LineTokenSource } {
  const { accountId, baseConfig, accountConfig, configDir } = params;

  // Check account-level config first
  if (accountConfig?.channelAccessToken?.trim()) {
    return { token: accountConfig.channelAccessToken.trim(), tokenSource: "config" };
  }

  // Check account-level token file
  const accountFileToken = readFileIfExists(accountConfig?.tokenFile, configDir);
  if (accountFileToken) {
    return { token: accountFileToken, tokenSource: "file" };
  }

  // For default account, check base config and env
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.channelAccessToken?.trim()) {
      return { token: baseConfig.channelAccessToken.trim(), tokenSource: "config" };
    }

    const baseFileToken = readFileIfExists(baseConfig?.tokenFile, configDir);
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
  configDir: string | undefined;
}): string {
  const { accountId, baseConfig, accountConfig, configDir } = params;

  // Check account-level config first
  if (accountConfig?.channelSecret?.trim()) {
    return accountConfig.channelSecret.trim();
  }

  // Check account-level secret file
  const accountFileSecret = readFileIfExists(accountConfig?.secretFile, configDir);
  if (accountFileSecret) {
    return accountFileSecret;
  }

  // For default account, check base config and env
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.channelSecret?.trim()) {
      return baseConfig.channelSecret.trim();
    }

    const baseFileSecret = readFileIfExists(baseConfig?.secretFile, configDir);
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
  /** Directory of the OpenClaw config file; used to resolve relative tokenFile/secretFile paths. */
  configDir?: string;
}): ResolvedLineAccount {
  const cfg = params.cfg;
  const accountId = normalizeSharedAccountId(params.accountId);
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  const accounts = lineConfig?.accounts;
  const accountConfig =
    accountId !== DEFAULT_ACCOUNT_ID ? resolveAccountEntry(accounts, accountId) : undefined;

  // Resolve the config directory so relative tokenFile/secretFile paths work correctly.
  const configDir = params.configDir ?? path.dirname(resolveConfigPath());

  const { token, tokenSource } = resolveToken({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
    configDir,
  });

  const secret = resolveSecret({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
    configDir,
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
