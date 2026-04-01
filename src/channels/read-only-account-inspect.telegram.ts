import type { OpenClawConfig } from "../config/config.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { TelegramAccountConfig } from "../config/types.telegram.js";
import { tryReadSecretFileSync } from "../infra/secret-file.js";
import {
  resolveAccountWithDefaultFallback,
  listCombinedAccountIds,
  resolveListedDefaultAccountId,
  resolveAccountEntry,
} from "../plugin-sdk/account-core.js";
import { resolveDefaultSecretProviderAlias } from "../plugin-sdk/provider-auth.js";
import { listBoundAccountIds, resolveDefaultAgentBoundAccountId } from "../routing/bindings.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../routing/session-key.js";

export type TelegramCredentialStatus = "available" | "configured_unavailable" | "missing";

export type InspectedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  tokenStatus: TelegramCredentialStatus;
  configured: boolean;
  config: TelegramAccountConfig;
};

export function normalizeTelegramAllowFromEntry(raw: unknown): string {
  const base = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  return base
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
}

export function isNumericTelegramUserId(raw: string): boolean {
  return /^-?\d+$/.test(raw);
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  for (const key of Object.keys(cfg.channels?.telegram?.accounts ?? {})) {
    if (key) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

export function listTelegramAccountIds(cfg: OpenClawConfig): string[] {
  return listCombinedAccountIds({
    configuredAccountIds: listConfiguredAccountIds(cfg),
    additionalAccountIds: listBoundAccountIds(cfg, "telegram"),
    fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
  });
}

export function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
  if (boundDefault) {
    return boundDefault;
  }
  return resolveListedDefaultAccountId({
    accountIds: listTelegramAccountIds(cfg),
    configuredDefaultAccountId: normalizeOptionalAccountId(cfg.channels?.telegram?.defaultAccount),
  });
}

function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.telegram?.accounts, normalizeAccountId(accountId));
}

function mergeTelegramAccountConfig(cfg: OpenClawConfig, accountId: string): TelegramAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    groups: channelGroups,
    ...base
  } = (cfg.channels?.telegram ?? {}) as TelegramAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveTelegramAccountConfig(cfg, accountId) ?? {};
  const configuredAccountIds = Object.keys(cfg.channels?.telegram?.accounts ?? {});
  const groups = account.groups ?? (configuredAccountIds.length > 1 ? undefined : channelGroups);
  return { ...base, ...account, groups };
}

function inspectTokenFile(pathValue: unknown): {
  token: string;
  tokenSource: "tokenFile" | "none";
  tokenStatus: TelegramCredentialStatus;
} | null {
  const tokenFile = typeof pathValue === "string" ? pathValue.trim() : "";
  if (!tokenFile) {
    return null;
  }
  const token = tryReadSecretFileSync(tokenFile, "Telegram bot token", {
    rejectSymlink: true,
  });
  return {
    token: token ?? "",
    tokenSource: "tokenFile",
    tokenStatus: token ? "available" : "configured_unavailable",
  };
}

function canResolveEnvSecretRefInReadOnlyPath(params: {
  cfg: OpenClawConfig;
  provider: string;
  id: string;
}): boolean {
  const providerConfig = params.cfg.secrets?.providers?.[params.provider];
  if (!providerConfig) {
    return params.provider === resolveDefaultSecretProviderAlias(params.cfg, "env");
  }
  if (providerConfig.source !== "env") {
    return false;
  }
  const allowlist = providerConfig.allowlist;
  return !allowlist || allowlist.includes(params.id);
}

function hasConfiguredSecretInput(value: unknown): boolean {
  return Boolean(coerceSecretRef(value) || (typeof value === "string" && value.trim()));
}

function normalizeSecretInputString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inspectTokenValue(params: { cfg: OpenClawConfig; value: unknown }): {
  token: string;
  tokenSource: "config" | "env" | "none";
  tokenStatus: TelegramCredentialStatus;
} | null {
  const ref = coerceSecretRef(params.value, params.cfg.secrets?.defaults);
  if (ref?.source === "env") {
    if (
      !canResolveEnvSecretRefInReadOnlyPath({
        cfg: params.cfg,
        provider: ref.provider,
        id: ref.id,
      })
    ) {
      return { token: "", tokenSource: "env", tokenStatus: "configured_unavailable" };
    }
    const envValue = process.env[ref.id];
    if (envValue && envValue.trim()) {
      return { token: envValue.trim(), tokenSource: "env", tokenStatus: "available" };
    }
    return { token: "", tokenSource: "env", tokenStatus: "configured_unavailable" };
  }
  const token = normalizeSecretInputString(params.value);
  if (token) {
    return { token, tokenSource: "config", tokenStatus: "available" };
  }
  if (hasConfiguredSecretInput(params.value)) {
    return { token: "", tokenSource: "config", tokenStatus: "configured_unavailable" };
  }
  return null;
}

function inspectTelegramAccountPrimary(params: {
  cfg: OpenClawConfig;
  accountId: string;
  envToken?: string | null;
}): InspectedTelegramAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeTelegramAccountConfig(params.cfg, accountId);
  const enabled = params.cfg.channels?.telegram?.enabled !== false && merged.enabled !== false;

  const accountConfig = resolveTelegramAccountConfig(params.cfg, accountId);
  const accountTokenFile = inspectTokenFile(accountConfig?.tokenFile);
  if (accountTokenFile) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: accountTokenFile.token,
      tokenSource: accountTokenFile.tokenSource,
      tokenStatus: accountTokenFile.tokenStatus,
      configured: accountTokenFile.tokenStatus !== "missing",
      config: merged,
    };
  }

  const accountToken = inspectTokenValue({ cfg: params.cfg, value: accountConfig?.botToken });
  if (accountToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: accountToken.token,
      tokenSource: accountToken.tokenSource,
      tokenStatus: accountToken.tokenStatus,
      configured: accountToken.tokenStatus !== "missing",
      config: merged,
    };
  }

  const channelTokenFile = inspectTokenFile(params.cfg.channels?.telegram?.tokenFile);
  if (channelTokenFile) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: channelTokenFile.token,
      tokenSource: channelTokenFile.tokenSource,
      tokenStatus: channelTokenFile.tokenStatus,
      configured: channelTokenFile.tokenStatus !== "missing",
      config: merged,
    };
  }

  const channelToken = inspectTokenValue({
    cfg: params.cfg,
    value: params.cfg.channels?.telegram?.botToken,
  });
  if (channelToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: channelToken.token,
      tokenSource: channelToken.tokenSource,
      tokenStatus: channelToken.tokenStatus,
      configured: channelToken.tokenStatus !== "missing",
      config: merged,
    };
  }

  const envToken =
    accountId === DEFAULT_ACCOUNT_ID
      ? (params.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim()
      : "";
  if (envToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: envToken,
      tokenSource: "env",
      tokenStatus: "available",
      configured: true,
      config: merged,
    };
  }

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
    configured: false,
    config: merged,
  };
}

export function inspectTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envToken?: string | null;
}): InspectedTelegramAccount {
  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    normalizeAccountId,
    resolvePrimary: (accountId) =>
      inspectTelegramAccountPrimary({
        cfg: params.cfg,
        accountId,
        envToken: params.envToken,
      }),
    hasCredential: (account) => account.tokenSource !== "none",
    resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg),
  });
}
