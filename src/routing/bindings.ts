import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeChatChannelId } from "../channels/registry.js";
import { listRouteBindings } from "../config/bindings.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentRouteBinding } from "../config/types.agents.js";
import { pickFirstExistingAgentId } from "./agent-lookup.js";
import { normalizeAccountId, normalizeAgentId } from "./session-key.js";

function normalizeBindingChannelId(raw?: string | null): string | null {
  const normalized = normalizeChatChannelId(raw);
  if (normalized) {
    return normalized;
  }
  const fallback = (raw ?? "").trim().toLowerCase();
  return fallback || null;
}

export function listBindings(cfg: OpenClawConfig): AgentRouteBinding[] {
  return listRouteBindings(cfg);
}

function resolveNormalizedBindingMatch(binding: AgentRouteBinding): {
  agentId: string;
  accountId: string;
  channelId: string;
} | null {
  if (!binding || typeof binding !== "object") {
    return null;
  }
  const match = binding.match;
  if (!match || typeof match !== "object") {
    return null;
  }
  const channelId = normalizeBindingChannelId(match.channel);
  if (!channelId) {
    return null;
  }
  const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
  if (!accountId || accountId === "*") {
    return null;
  }
  return {
    agentId: normalizeAgentId(binding.agentId),
    accountId: normalizeAccountId(accountId),
    channelId,
  };
}

function isScopedBinding(binding: AgentRouteBinding): boolean {
  const match = binding.match;
  if (!match || typeof match !== "object") {
    return false;
  }
  return Boolean(
    match.peer ||
    (typeof match.guildId === "string" && match.guildId.trim()) ||
    (typeof match.teamId === "string" && match.teamId.trim()) ||
    (Array.isArray(match.roles) &&
      match.roles.some((role) => typeof role === "string" && role.trim())),
  );
}

function resolveOwnershipBindingMatch(binding: AgentRouteBinding): {
  agentId: string;
  accountId: string;
  channelId: string;
  isWildcard: boolean;
} | null {
  if (!binding || typeof binding !== "object" || isScopedBinding(binding)) {
    return null;
  }
  const match = binding.match;
  if (!match || typeof match !== "object") {
    return null;
  }
  const channelId = normalizeBindingChannelId(match.channel);
  if (!channelId) {
    return null;
  }
  const rawAccountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
  const isWildcard = rawAccountId === "*";
  return {
    agentId: normalizeAgentId(binding.agentId),
    accountId: isWildcard ? "*" : normalizeAccountId(rawAccountId),
    channelId,
    isWildcard,
  };
}

export function listBoundAccountIds(cfg: OpenClawConfig, channelId: string): string[] {
  const normalizedChannel = normalizeBindingChannelId(channelId);
  if (!normalizedChannel) {
    return [];
  }
  const ids = new Set<string>();
  for (const binding of listBindings(cfg)) {
    const resolved = resolveNormalizedBindingMatch(binding);
    if (!resolved || resolved.channelId !== normalizedChannel) {
      continue;
    }
    ids.add(resolved.accountId);
  }
  return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultAgentBoundAccountId(
  cfg: OpenClawConfig,
  channelId: string,
): string | null {
  const normalizedChannel = normalizeBindingChannelId(channelId);
  if (!normalizedChannel) {
    return null;
  }
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  for (const binding of listBindings(cfg)) {
    const resolved = resolveNormalizedBindingMatch(binding);
    if (
      !resolved ||
      resolved.channelId !== normalizedChannel ||
      resolved.agentId !== defaultAgentId
    ) {
      continue;
    }
    return resolved.accountId;
  }
  return null;
}

export function resolveOwningAgentIdForChannelAccount(
  cfg: OpenClawConfig,
  channelId: string,
  accountId?: string | null,
): string | null {
  const normalizedChannel = normalizeBindingChannelId(channelId);
  if (!normalizedChannel) {
    return null;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  let wildcardAgentId: string | null = null;
  for (const binding of listBindings(cfg)) {
    const resolved = resolveOwnershipBindingMatch(binding);
    if (!resolved || resolved.channelId !== normalizedChannel) {
      continue;
    }
    if (resolved.isWildcard) {
      wildcardAgentId ??= pickFirstExistingAgentId(cfg, resolved.agentId);
      continue;
    }
    if (resolved.accountId === normalizedAccountId) {
      return pickFirstExistingAgentId(cfg, resolved.agentId);
    }
  }
  return wildcardAgentId ?? pickFirstExistingAgentId(cfg, resolveDefaultAgentId(cfg));
}

export function buildChannelAccountBindings(cfg: OpenClawConfig) {
  const map = new Map<string, Map<string, string[]>>();
  for (const binding of listBindings(cfg)) {
    const resolved = resolveNormalizedBindingMatch(binding);
    if (!resolved) {
      continue;
    }
    const byAgent = map.get(resolved.channelId) ?? new Map<string, string[]>();
    const list = byAgent.get(resolved.agentId) ?? [];
    if (!list.includes(resolved.accountId)) {
      list.push(resolved.accountId);
    }
    byAgent.set(resolved.agentId, list);
    map.set(resolved.channelId, byAgent);
  }
  return map;
}

export function resolvePreferredAccountId(params: {
  accountIds: string[];
  defaultAccountId: string;
  boundAccounts: string[];
}): string {
  if (params.boundAccounts.length > 0) {
    return params.boundAccounts[0];
  }
  return params.defaultAccountId;
}
