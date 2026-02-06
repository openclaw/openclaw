import type { ClawdbotConfig } from "../config/config.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../routing/session-key.js";
import type { GoogleChatAccountConfig } from "./types.js";

export type ResolvedGoogleChatAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  projectId: string;
  subscriptionName: string;
  credentialsPath?: string;
  config: GoogleChatAccountConfig;
};

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const googlechat = (
    cfg as { googlechat?: { accounts?: Record<string, unknown> } }
  ).googlechat;
  const accounts = googlechat?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listGoogleChatAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultGoogleChatAccountId(cfg: ClawdbotConfig): string {
  const ids = listGoogleChatAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): GoogleChatAccountConfig | undefined {
  const googlechat = (
    cfg as {
      googlechat?: { accounts?: Record<string, GoogleChatAccountConfig> };
    }
  ).googlechat;
  const accounts = googlechat?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId];
}

function mergeGoogleChatAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): GoogleChatAccountConfig {
  const googlechat =
    (cfg as { googlechat?: GoogleChatAccountConfig & { accounts?: unknown } })
      .googlechat ?? {};
  const { accounts: _ignored, ...base } = googlechat;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveGoogleChatAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedGoogleChatAccount {
  const googlechat = (params.cfg as { googlechat?: { enabled?: boolean } })
    .googlechat;
  const baseEnabled = googlechat?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeGoogleChatAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      projectId: merged.projectId ?? "",
      subscriptionName: merged.subscriptionName ?? "",
      credentialsPath: merged.credentialsPath,
      config: merged,
    } satisfies ResolvedGoogleChatAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  return resolve(normalized);
}

export function listEnabledGoogleChatAccounts(
  cfg: ClawdbotConfig,
): ResolvedGoogleChatAccount[] {
  return listGoogleChatAccountIds(cfg)
    .map((accountId) => resolveGoogleChatAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
