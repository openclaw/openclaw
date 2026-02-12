import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeChatChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentBinding } from "../config/types.agents.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeAgentId } from "./session-key.js";

function normalizeBindingChannelId(raw?: string | null): string | null {
  const normalized = normalizeChatChannelId(raw);
  if (normalized) {
    return normalized;
  }
  const fallback = (raw ?? "").trim().toLowerCase();
  return fallback || null;
}

export function listBindings(cfg: OpenClawConfig): AgentBinding[] {
  return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}

function resolveNormalizedBindingMatch(binding: AgentBinding): {
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

function matchesBindingAccountId(match: string | undefined, actual: string): boolean {
  const trimmed = (match ?? "").trim();
  if (!trimmed) {
    return actual === DEFAULT_ACCOUNT_ID;
  }
  if (trimmed === "*") {
    return true;
  }
  return normalizeAccountId(trimmed) === actual;
}

export function listBoundAgentIds(params: {
  cfg: OpenClawConfig;
  channelId: string;
  accountId?: string | null;
  includeDefault?: boolean;
}): string[] {
  const normalizedChannel = normalizeBindingChannelId(params.channelId);
  if (!normalizedChannel) {
    if (params.includeDefault === false) {
      return [];
    }
    return [normalizeAgentId(resolveDefaultAgentId(params.cfg))];
  }
  const normalizedAccount = normalizeAccountId(params.accountId);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const binding of listBindings(params.cfg)) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    const match = binding.match;
    if (!match || typeof match !== "object") {
      continue;
    }
    const channel = normalizeBindingChannelId(match.channel);
    if (!channel || channel !== normalizedChannel) {
      continue;
    }
    if (!matchesBindingAccountId(match.accountId, normalizedAccount)) {
      continue;
    }
    const agentId = normalizeAgentId(binding.agentId);
    if (seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    ids.push(agentId);
  }
  if (ids.length === 0 && params.includeDefault !== false) {
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
    if (!seen.has(defaultAgentId)) {
      ids.push(defaultAgentId);
    }
  }
  return ids;
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
