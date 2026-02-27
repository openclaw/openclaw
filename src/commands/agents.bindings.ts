import type { ChannelId } from "../channels/plugins/types.js";
import type { BotConfig } from "../config/config.js";
import type { AgentBinding } from "../config/types.js";
import type { ChannelChoice } from "./onboard-types.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../routing/session-key.js";

function bindingMatchKey(match: AgentBinding["match"]) {
  const accountId = match.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  return [
    match.channel,
    accountId,
    match.peer?.kind ?? "",
    match.peer?.id ?? "",
    match.guildId ?? "",
    match.teamId ?? "",
  ].join("|");
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
  cfg: BotConfig,
  bindings: AgentBinding[],
): {
  config: BotConfig;
  added: AgentBinding[];
  updated: AgentBinding[];
  skipped: AgentBinding[];
  conflicts: Array<{ binding: AgentBinding; existingAgentId: string }>;
} {
  const existing = cfg.bindings ?? [];
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
    existingMatchMap.set(key, agentId);
    added.push({ ...binding, agentId });
  }

  if (added.length === 0) {
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

function resolveDefaultAccountId(cfg: BotConfig, provider: ChannelId): string {
  const plugin = getChannelPlugin(provider);
  if (!plugin) {
    return DEFAULT_ACCOUNT_ID;
  }
  return resolveChannelDefaultAccountId({ plugin, cfg });
}

export function buildChannelBindings(params: {
  agentId: string;
  selection: ChannelChoice[];
  config: BotConfig;
  accountIds?: Partial<Record<ChannelChoice, string>>;
}): AgentBinding[] {
  const bindings: AgentBinding[] = [];
  const agentId = normalizeAgentId(params.agentId);
  for (const channel of params.selection) {
    const match: AgentBinding["match"] = { channel };
    const accountId = params.accountIds?.[channel]?.trim();
    if (accountId) {
      match.accountId = accountId;
    } else {
      const plugin = getChannelPlugin(channel);
      if (plugin?.meta.forceAccountBinding) {
        match.accountId = resolveDefaultAccountId(params.config, channel);
      }
    }
    bindings.push({ agentId, match });
  }
  return bindings;
}

export function removeAgentBindings(
  cfg: BotConfig,
  bindings: AgentBinding[],
): {
  config: BotConfig;
  removed: AgentBinding[];
  missing: AgentBinding[];
  conflicts: Array<{ binding: AgentBinding; existingAgentId: string }>;
} {
  const existing = cfg.bindings ?? [];
  const existingMatchMap = new Map<string, { binding: AgentBinding; index: number }>();
  for (let i = 0; i < existing.length; i++) {
    const binding = existing[i];
    const key = bindingMatchKey(binding.match);
    if (!existingMatchMap.has(key)) {
      existingMatchMap.set(key, { binding, index: i });
    }
  }

  const removed: AgentBinding[] = [];
  const missing: AgentBinding[] = [];
  const conflicts: Array<{ binding: AgentBinding; existingAgentId: string }> = [];
  const indicesToRemove = new Set<number>();

  for (const binding of bindings) {
    const agentId = normalizeAgentId(binding.agentId);
    const key = bindingMatchKey(binding.match);
    const entry = existingMatchMap.get(key);
    if (!entry) {
      missing.push(binding);
      continue;
    }
    const existingAgentId = normalizeAgentId(entry.binding.agentId);
    if (existingAgentId !== agentId) {
      conflicts.push({ binding, existingAgentId });
      continue;
    }
    removed.push(entry.binding);
    indicesToRemove.add(entry.index);
  }

  if (removed.length === 0) {
    return { config: cfg, removed, missing, conflicts };
  }

  const kept = existing.filter((_, i) => !indicesToRemove.has(i));
  return {
    config: {
      ...cfg,
      bindings: kept.length > 0 ? kept : undefined,
    },
    removed,
    missing,
    conflicts,
  };
}

export function parseBindingSpecs(params: {
  agentId: string;
  specs?: string[];
  config: BotConfig;
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
    let accountId = accountRaw?.trim();
    if (accountRaw !== undefined && !accountId) {
      errors.push(`Invalid binding "${trimmed}" (empty account id).`);
      continue;
    }
    if (!accountId) {
      const plugin = getChannelPlugin(channel);
      if (plugin?.meta.forceAccountBinding) {
        accountId = resolveDefaultAccountId(params.config, channel);
      }
    }
    const match: AgentBinding["match"] = { channel };
    if (accountId) {
      match.accountId = accountId;
    }
    bindings.push({ agentId, match });
  }
  return { bindings, errors };
}
