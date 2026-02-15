import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import type {
  MessengerConfig,
  MessengerAccountConfig,
  ResolvedMessengerAccount,
  MessengerTokenSource,
} from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

function readFileIfExists(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

function resolvePageAccessToken(params: {
  accountId: string;
  baseConfig?: MessengerConfig;
  accountConfig?: MessengerAccountConfig;
}): { token: string; tokenSource: MessengerTokenSource } {
  const { accountId, baseConfig, accountConfig } = params;

  if (accountConfig?.pageAccessToken?.trim()) {
    return { token: accountConfig.pageAccessToken.trim(), tokenSource: "config" };
  }

  const accountFileToken = readFileIfExists(accountConfig?.tokenFile);
  if (accountFileToken) {
    return { token: accountFileToken, tokenSource: "file" };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.pageAccessToken?.trim()) {
      return { token: baseConfig.pageAccessToken.trim(), tokenSource: "config" };
    }

    const baseFileToken = readFileIfExists(baseConfig?.tokenFile);
    if (baseFileToken) {
      return { token: baseFileToken, tokenSource: "file" };
    }

    const envToken = process.env.MESSENGER_PAGE_ACCESS_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, tokenSource: "env" };
    }
  }

  return { token: "", tokenSource: "none" };
}

function resolveAppSecret(params: {
  accountId: string;
  baseConfig?: MessengerConfig;
  accountConfig?: MessengerAccountConfig;
}): string {
  const { accountId, baseConfig, accountConfig } = params;

  if (accountConfig?.appSecret?.trim()) {
    return accountConfig.appSecret.trim();
  }

  const accountFileSecret = readFileIfExists(accountConfig?.secretFile);
  if (accountFileSecret) {
    return accountFileSecret;
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.appSecret?.trim()) {
      return baseConfig.appSecret.trim();
    }

    const baseFileSecret = readFileIfExists(baseConfig?.secretFile);
    if (baseFileSecret) {
      return baseFileSecret;
    }

    const envSecret = process.env.MESSENGER_APP_SECRET?.trim();
    if (envSecret) {
      return envSecret;
    }
  }

  return "";
}

function resolveVerifyToken(params: {
  accountId: string;
  baseConfig?: MessengerConfig;
  accountConfig?: MessengerAccountConfig;
}): string {
  const { accountId, baseConfig, accountConfig } = params;

  if (accountConfig?.verifyToken?.trim()) {
    return accountConfig.verifyToken.trim();
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.verifyToken?.trim()) {
      return baseConfig.verifyToken.trim();
    }

    const envVerifyToken = process.env.MESSENGER_VERIFY_TOKEN?.trim();
    if (envVerifyToken) {
      return envVerifyToken;
    }
  }

  return "";
}

export function resolveMessengerAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedMessengerAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;
  const messengerConfig = cfg.channels?.messenger as MessengerConfig | undefined;
  const accounts = messengerConfig?.accounts;
  const accountConfig = accountId !== DEFAULT_ACCOUNT_ID ? accounts?.[accountId] : undefined;

  const { token, tokenSource } = resolvePageAccessToken({
    accountId,
    baseConfig: messengerConfig,
    accountConfig,
  });

  const appSecret = resolveAppSecret({
    accountId,
    baseConfig: messengerConfig,
    accountConfig,
  });

  const verifyToken = resolveVerifyToken({
    accountId,
    baseConfig: messengerConfig,
    accountConfig,
  });

  const mergedConfig: MessengerConfig & MessengerAccountConfig = {
    ...messengerConfig,
    ...accountConfig,
  };

  const enabled =
    accountConfig?.enabled ??
    (accountId === DEFAULT_ACCOUNT_ID ? (messengerConfig?.enabled ?? true) : false);

  const name =
    accountConfig?.name ?? (accountId === DEFAULT_ACCOUNT_ID ? messengerConfig?.name : undefined);

  return {
    accountId,
    name,
    enabled,
    pageAccessToken: token,
    appSecret,
    verifyToken,
    tokenSource,
    config: mergedConfig,
  };
}

export function listMessengerAccountIds(cfg: OpenClawConfig): string[] {
  const messengerConfig = cfg.channels?.messenger as MessengerConfig | undefined;
  const accounts = messengerConfig?.accounts;
  const ids = new Set<string>();

  if (
    messengerConfig?.pageAccessToken?.trim() ||
    messengerConfig?.tokenFile ||
    process.env.MESSENGER_PAGE_ACCESS_TOKEN?.trim()
  ) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (accounts) {
    for (const id of Object.keys(accounts)) {
      ids.add(id);
    }
  }

  return Array.from(ids);
}

export function resolveDefaultMessengerAccountId(cfg: OpenClawConfig): string {
  const ids = listMessengerAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function normalizeAccountId(accountId: string | undefined): string {
  const trimmed = accountId?.trim().toLowerCase();
  if (!trimmed || trimmed === "default") {
    return DEFAULT_ACCOUNT_ID;
  }
  return trimmed;
}
