import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { IMessageAccountConfig } from "../config/types.js";
import { normalizeAccountId } from "../routing/session-key.js";

export type ResolvedIMessageAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: IMessageAccountConfig;
  configured: boolean;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("imessage");
export const listIMessageAccountIds = listAccountIds;
export const resolveDefaultIMessageAccountId = resolveDefaultAccountId;

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): IMessageAccountConfig | undefined {
  const accounts = cfg.channels?.imessage?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as IMessageAccountConfig | undefined;
}

function mergeIMessageAccountConfig(cfg: OpenClawConfig, accountId: string): IMessageAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.imessage ??
    {}) as IMessageAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveIMessageAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedIMessageAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.imessage?.enabled !== false;
  const merged = mergeIMessageAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const configured = Boolean(
    merged.cliPath?.trim() ||
    merged.dbPath?.trim() ||
    merged.service ||
    merged.region?.trim() ||
    (merged.allowFrom && merged.allowFrom.length > 0) ||
    (merged.groupAllowFrom && merged.groupAllowFrom.length > 0) ||
    merged.dmPolicy ||
    merged.groupPolicy ||
    typeof merged.includeAttachments === "boolean" ||
    (merged.attachmentRoots && merged.attachmentRoots.length > 0) ||
    (merged.remoteAttachmentRoots && merged.remoteAttachmentRoots.length > 0) ||
    typeof merged.mediaMaxMb === "number" ||
    typeof merged.textChunkLimit === "number" ||
    (merged.groups && Object.keys(merged.groups).length > 0),
  );
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    config: merged,
    configured,
  };
}

export function listEnabledIMessageAccounts(cfg: OpenClawConfig): ResolvedIMessageAccount[] {
  return listIMessageAccountIds(cfg)
    .map((accountId) => resolveIMessageAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
