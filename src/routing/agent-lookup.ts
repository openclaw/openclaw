import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId, sanitizeAgentId } from "./session-key.js";

type AgentLookupCache = {
  agentsRef: OpenClawConfig["agents"] | undefined;
  byNormalizedId: Map<string, string>;
  fallbackDefaultAgentId: string;
};

const agentLookupCacheByCfg = new WeakMap<OpenClawConfig, AgentLookupCache>();

function listAgents(cfg: OpenClawConfig) {
  const agents = cfg.agents?.list;
  return Array.isArray(agents) ? agents : [];
}

function resolveAgentLookupCache(cfg: OpenClawConfig): AgentLookupCache {
  const agentsRef = cfg.agents;
  const existing = agentLookupCacheByCfg.get(cfg);
  if (existing && existing.agentsRef === agentsRef) {
    return existing;
  }

  const byNormalizedId = new Map<string, string>();
  for (const agent of listAgents(cfg)) {
    const rawId = agent.id?.trim();
    if (!rawId) {
      continue;
    }
    byNormalizedId.set(normalizeAgentId(rawId), sanitizeAgentId(rawId));
  }
  const next: AgentLookupCache = {
    agentsRef,
    byNormalizedId,
    fallbackDefaultAgentId: sanitizeAgentId(resolveDefaultAgentId(cfg)),
  };
  agentLookupCacheByCfg.set(cfg, next);
  return next;
}

export function pickFirstExistingAgentId(cfg: OpenClawConfig, agentId: string): string {
  const lookup = resolveAgentLookupCache(cfg);
  const trimmed = (agentId ?? "").trim();
  if (!trimmed) {
    return lookup.fallbackDefaultAgentId;
  }
  const normalized = normalizeAgentId(trimmed);
  if (lookup.byNormalizedId.size === 0) {
    return sanitizeAgentId(trimmed);
  }
  const resolved = lookup.byNormalizedId.get(normalized);
  if (resolved) {
    return resolved;
  }
  return lookup.fallbackDefaultAgentId;
}
