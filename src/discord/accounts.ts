import { createAccountActionGate } from "../channels/plugins/account-action-gate.js";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DiscordAccountConfig, DiscordActionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveDiscordToken } from "./token.js";

export type ResolvedDiscordAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  config: DiscordAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("discord");
export const listDiscordAccountIds = listAccountIds;
export const resolveDefaultDiscordAccountId = resolveDefaultAccountId;
const log = createSubsystemLogger("discord/accounts");
const warnedEmptyGuildOverrides = new Set<string>();

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function hasObjectKeys(value: unknown): boolean {
  const record = asObjectRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DiscordAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.discord?.accounts, accountId);
}

function mergeDiscordAccountConfig(cfg: OpenClawConfig, accountId: string): DiscordAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.discord ?? {}) as DiscordAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const merged = { ...base, ...account };
  const accountExplicitlyOverridesGuilds = Object.hasOwn(account, "guilds");
  const accountGuildsEmpty = !hasObjectKeys(account.guilds);
  const parentGuildsConfigured = hasObjectKeys(base.guilds);

  // Preserve parent guild allowlist when an account sets allowlist mode but leaves
  // guilds empty (for example `guilds: {}`), which otherwise overrides to deny-all.
  if (
    merged.groupPolicy === "allowlist" &&
    accountExplicitlyOverridesGuilds &&
    accountGuildsEmpty &&
    parentGuildsConfigured
  ) {
    if (!warnedEmptyGuildOverrides.has(accountId)) {
      warnedEmptyGuildOverrides.add(accountId);
      log.warn?.(
        `channels.discord.accounts.${accountId}.groupPolicy is "allowlist" but guilds is empty; inheriting channels.discord.guilds for this account. Configure channels.discord.accounts.${accountId}.guilds explicitly or remove the empty override.`,
      );
    }
    merged.guilds = base.guilds;
  }

  return merged;
}

export function createDiscordActionGate(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): (key: keyof DiscordActionConfig, defaultValue?: boolean) => boolean {
  const accountId = normalizeAccountId(params.accountId);
  return createAccountActionGate({
    baseActions: params.cfg.channels?.discord?.actions,
    accountActions: resolveAccountConfig(params.cfg, accountId)?.actions,
  });
}

export function resolveDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged,
  };
}

export function listEnabledDiscordAccounts(cfg: OpenClawConfig): ResolvedDiscordAccount[] {
  return listDiscordAccountIds(cfg)
    .map((accountId) => resolveDiscordAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
