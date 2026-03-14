import { logWarn } from "../logger.js";
import { normalizeAccountId, normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import type { AgentAcpBinding, AgentBinding, AgentRouteBinding } from "./types.agents.js";

function normalizeBindingType(binding: AgentBinding): "route" | "acp" {
  return binding.type === "acp" ? "acp" : "route";
}

export function isRouteBinding(binding: AgentBinding): binding is AgentRouteBinding {
  return normalizeBindingType(binding) === "route";
}

export function isAcpBinding(binding: AgentBinding): binding is AgentAcpBinding {
  return normalizeBindingType(binding) === "acp";
}

export function listConfiguredBindings(cfg: OpenClawConfig): AgentBinding[] {
  return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}

/**
 * Synthesize route bindings from Discord accounts that have an effective `agentId`.
 * Each account with a valid `agentId` produces a route binding:
 *   { match: { channel: "discord", accountId }, agentId }
 *
 * The effective `agentId` for an account is resolved as:
 *   account-level `agentId` > top-level `channels.discord.agentId`
 * This mirrors how `mergeDiscordAccountConfig` applies top-level Discord
 * config as defaults for all accounts.
 *
 * In single-account setups (no `accounts` map), the implicit "default"
 * account inherits the top-level `agentId`.
 *
 * Accounts referencing an `agentId` not present in `agents.list` are skipped
 * with a warning (fail-secure: no binding created, default routing applies).
 *
 * Explicit bindings in `cfg.bindings` take precedence over synthesized ones.
 * A warning is logged when a synthesized binding is shadowed by an explicit one.
 */
export function synthesizeDiscordAccountBindings(
  cfg: OpenClawConfig,
  explicitBindings: AgentRouteBinding[],
): AgentRouteBinding[] {
  const discordConfig = cfg.channels?.discord;
  if (!discordConfig) {
    return [];
  }
  const topLevelAgentId = discordConfig.agentId?.trim() || "";
  const accounts = discordConfig.accounts;
  // When no accounts map exists (or it's empty), the implicit "default" account
  // inherits top-level config (including agentId). Build a synthetic entries list
  // so the loop below handles both cases uniformly.
  const hasAccounts = accounts && Object.keys(accounts).length > 0;
  const accountEntries: [string, { agentId?: string } | undefined][] = hasAccounts
    ? Object.entries(accounts)
    : topLevelAgentId
      ? [["default", undefined]]
      : [];
  if (accountEntries.length === 0) {
    return [];
  }
  const agentIds = new Set(
    (cfg.agents?.list ?? []).filter((a) => a.id?.trim()).map((a) => normalizeAgentId(a.id)),
  );
  const explicitDiscordBindings = explicitBindings.filter(
    (b) => (b.match.channel ?? "").trim().toLowerCase() === "discord",
  );
  // Only accountId: "*" is a true wildcard covering all accounts.
  // A missing accountId maps to DEFAULT_ACCOUNT_ID ("default") in routing,
  // so it only shadows the default account — not all accounts.
  const isUnscoped = (b: AgentRouteBinding): boolean => {
    const m = b.match;
    return !m.peer && !m.guildId && !m.teamId && (!m.roles || m.roles.length === 0);
  };
  const hasWildcardExplicit = explicitDiscordBindings.some(
    (b) => b.match.accountId?.trim() === "*" && isUnscoped(b),
  );
  // Build the set of account IDs covered by unscoped explicit bindings.
  // Bindings with no accountId target "default"; scoped bindings are excluded.
  const explicitDiscordAccountIds = new Set(
    explicitDiscordBindings
      .filter((b) => b.match.accountId?.trim() !== "*" && isUnscoped(b))
      .map((b) => normalizeAccountId(b.match.accountId)),
  );
  const bindings: AgentRouteBinding[] = [];
  for (const [accountId, account] of accountEntries) {
    // Effective agentId: account-level overrides top-level.
    // An explicit empty agentId ("") opts out of the top-level agent.
    const rawAgentId = account?.agentId !== undefined ? account.agentId.trim() : topLevelAgentId;
    if (!rawAgentId) {
      continue;
    }
    const agentId = normalizeAgentId(rawAgentId);
    if (!agentIds.has(agentId)) {
      logWarn(
        `[bindings] Discord account "${accountId}" references agentId "${rawAgentId}" which does not exist in agents.list — skipping binding`,
      );
      continue;
    }
    if (hasWildcardExplicit || explicitDiscordAccountIds.has(normalizeAccountId(accountId))) {
      logWarn(
        `[bindings] Discord account "${accountId}" has agentId "${rawAgentId}" but is already covered by an explicit binding — explicit binding takes precedence`,
      );
      continue;
    }
    bindings.push({
      agentId,
      match: { channel: "discord", accountId },
    });
  }
  return bindings;
}

export function listRouteBindings(cfg: OpenClawConfig): AgentRouteBinding[] {
  return listConfiguredBindings(cfg).filter(isRouteBinding);
}

export function listAcpBindings(cfg: OpenClawConfig): AgentAcpBinding[] {
  return listConfiguredBindings(cfg).filter(isAcpBinding);
}
