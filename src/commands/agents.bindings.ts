import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentBinding } from "../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { ChannelChoice } from "./onboard-types.js";

function bindingMatchKey(match: AgentBinding["match"]) {
  const accountId = match.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const identityKey = bindingMatchIdentityKey(match);
  return [identityKey, accountId].join("|");
}

function bindingMatchIdentityKey(match: AgentBinding["match"]) {
  const roles = Array.isArray(match.roles)
    ? Array.from(
        new Set(
          match.roles
            .map((role) => role.trim())
            .filter(Boolean)
            .toSorted(),
        ),
      )
    : [];
  return [
    match.channel,
    match.peer?.kind ?? "",
    match.peer?.id ?? "",
    match.guildId ?? "",
    match.teamId ?? "",
    roles.join(","),
  ].join("|");
}

function canUpgradeBindingAccountScope(params: {
  existing: AgentBinding;
  incoming: AgentBinding;
  normalizedIncomingAgentId: string;
}): boolean {
  if (!params.incoming.match.accountId?.trim()) {
    return false;
  }
  if (params.existing.match.accountId?.trim()) {
    return false;
  }
  if (normalizeAgentId(params.existing.agentId) !== params.normalizedIncomingAgentId) {
    return false;
  }
  return (
    bindingMatchIdentityKey(params.existing.match) ===
    bindingMatchIdentityKey(params.incoming.match)
  );
}

export function describeBinding(binding: AgentBinding) {
  const match = binding.match;
  const parts = [match.channel];
  if (match.accountId) {
    parts.push(`accountId=${match.accountId}`);
  }
  if (match.peer) {
    parts.push(`peer=${match.peer.kind}:${match.peer.id}`);
  }
  if (match.guildId) {
    parts.push(`guild=${match.guildId}`);
  }
  if (match.teamId) {
    parts.push(`team=${match.teamId}`);
  }
  return parts.join(" ");
}

export function applyAgentBindings(
  cfg: OpenClawConfig,
  bindings: AgentBinding[],
): {
  config: OpenClawConfig;
  added: AgentBinding[];
  updated: AgentBinding[];
  skipped: AgentBinding[];
  conflicts: Array<{ binding: AgentBinding; existingAgentId: string }>;
} {
  const existing = [...(cfg.bindings ?? [])];
  const existingMatchMap = new Map<string, string>();
  for (const binding of existing) {
    const key = bindingMatchKey(binding.match);
    if (!existingMatchMap.has(key)) {
      existingMatchMap.set(key, normalizeAgentId(binding.agentId));
    }
  }

  const added: AgentBinding[] = [];
  const updated: AgentBinding[] = [];
  const skipped: AgentBinding[] = [];
  const conflicts: Array<{ binding: AgentBinding; existingAgentId: string }> = [];

  for (const binding of bindings) {
    const agentId = normalizeAgentId(binding.agentId);
    const key = bindingMatchKey(binding.match);
    const existingAgentId = existingMatchMap.get(key);
    if (existingAgentId) {
      if (existingAgentId === agentId) {
        skipped.push(binding);
      } else {
        conflicts.push({ binding, existingAgentId });
      }
      continue;
    }

    const upgradeIndex = existing.findIndex((candidate) =>
      canUpgradeBindingAccountScope({
        existing: candidate,
        incoming: binding,
        normalizedIncomingAgentId: agentId,
      }),
    );
    if (upgradeIndex >= 0) {
      const current = existing[upgradeIndex];
      if (!current) {
        continue;
      }
      const previousKey = bindingMatchKey(current.match);
      const upgradedBinding: AgentBinding = {
        ...current,
        agentId,
        match: {
          ...current.match,
          accountId: binding.match.accountId?.trim(),
        },
      };
      existing[upgradeIndex] = upgradedBinding;
      existingMatchMap.delete(previousKey);
      existingMatchMap.set(bindingMatchKey(upgradedBinding.match), agentId);
      updated.push(upgradedBinding);
      continue;
    }

    existingMatchMap.set(key, agentId);
    added.push({ ...binding, agentId });
  }

  if (added.length === 0 && updated.length === 0) {
    return { config: cfg, added, updated, skipped, conflicts };
  }

  return {
    config: {
      ...cfg,
      bindings: [...existing, ...added],
    },
    added,
    updated,
    skipped,
    conflicts,
  };
}

export function removeAgentBindings(
  cfg: OpenClawConfig,
  bindings: AgentBinding[],
): {
  config: OpenClawConfig;
  removed: AgentBinding[];
  missing: AgentBinding[];
  conflicts: Array<{ binding: AgentBinding; existingAgentId: string }>;
} {
  const existing = cfg.bindings ?? [];
  const removeIndexes = new Set<number>();
  const removed: AgentBinding[] = [];
  const missing: AgentBinding[] = [];
  const conflicts: Array<{ binding: AgentBinding; existingAgentId: string }> = [];

  for (const binding of bindings) {
    const desiredAgentId = normalizeAgentId(binding.agentId);
    const key = bindingMatchKey(binding.match);
    let matchedIndex = -1;
    let conflictingAgentId: string | null = null;
    for (let i = 0; i < existing.length; i += 1) {
      if (removeIndexes.has(i)) {
        continue;
      }
      const current = existing[i];
      if (!current || bindingMatchKey(current.match) !== key) {
        continue;
      }
      const currentAgentId = normalizeAgentId(current.agentId);
      if (currentAgentId === desiredAgentId) {
        matchedIndex = i;
        break;
      }
      conflictingAgentId = currentAgentId;
    }
    if (matchedIndex >= 0) {
      const matched = existing[matchedIndex];
      if (matched) {
        removeIndexes.add(matchedIndex);
        removed.push(matched);
      }
      continue;
    }
    if (conflictingAgentId) {
      conflicts.push({ binding, existingAgentId: conflictingAgentId });
      continue;
    }
    missing.push(binding);
  }

  if (removeIndexes.size === 0) {
    return { config: cfg, removed, missing, conflicts };
  }

  const nextBindings = existing.filter((_, index) => !removeIndexes.has(index));
  return {
    config: {
      ...cfg,
      bindings: nextBindings.length > 0 ? nextBindings : undefined,
    },
    removed,
    missing,
    conflicts,
  };
}

function resolveDefaultAccountId(cfg: OpenClawConfig, provider: ChannelId): string {
  const plugin = getChannelPlugin(provider);
  if (!plugin) {
    return DEFAULT_ACCOUNT_ID;
  }
  return resolveChannelDefaultAccountId({ plugin, cfg });
}

function resolveBindingAccountId(params: {
  channel: ChannelId;
  config: OpenClawConfig;
  agentId: string;
  explicitAccountId?: string;
}): string | undefined {
  const explicitAccountId = params.explicitAccountId?.trim();
  if (explicitAccountId) {
    return explicitAccountId;
  }

  const plugin = getChannelPlugin(params.channel);
  const pluginAccountId = plugin?.setup?.resolveBindingAccountId?.({
    cfg: params.config,
    agentId: params.agentId,
  });
  if (pluginAccountId?.trim()) {
    return pluginAccountId.trim();
  }

  if (plugin?.meta.forceAccountBinding) {
    return resolveDefaultAccountId(params.config, params.channel);
  }

  return undefined;
}

export function buildChannelBindings(params: {
  agentId: string;
  selection: ChannelChoice[];
  config: OpenClawConfig;
  accountIds?: Partial<Record<ChannelChoice, string>>;
}): AgentBinding[] {
  const bindings: AgentBinding[] = [];
  const agentId = normalizeAgentId(params.agentId);
  for (const channel of params.selection) {
    const match: AgentBinding["match"] = { channel };
    const accountId = resolveBindingAccountId({
      channel,
      config: params.config,
      agentId,
      explicitAccountId: params.accountIds?.[channel],
    });
    if (accountId) {
      match.accountId = accountId;
    }
    bindings.push({ agentId, match });
  }
  return bindings;
}

export function parseBindingSpecs(params: {
  agentId: string;
  specs?: string[];
  config: OpenClawConfig;
}): { bindings: AgentBinding[]; errors: string[] } {
  const bindings: AgentBinding[] = [];
  const errors: string[] = [];
  const specs = params.specs ?? [];
  const agentId = normalizeAgentId(params.agentId);
  for (const raw of specs) {
    const trimmed = raw?.trim();
    if (!trimmed) {
      continue;
    }
    const [channelRaw, accountRaw] = trimmed.split(":", 2);
    const channel = normalizeChannelId(channelRaw);
    if (!channel) {
      errors.push(`Unknown channel "${channelRaw}".`);
      continue;
    }
    let accountId: string | undefined = accountRaw?.trim();
    if (accountRaw !== undefined && !accountId) {
      errors.push(`Invalid binding "${trimmed}" (empty account id).`);
      continue;
    }
    accountId = resolveBindingAccountId({
      channel,
      config: params.config,
      agentId,
      explicitAccountId: accountId,
    });
    const match: AgentBinding["match"] = { channel };
    if (accountId) {
      match.accountId = accountId;
    }
    bindings.push({ agentId, match });
  }
  return { bindings, errors };
}
