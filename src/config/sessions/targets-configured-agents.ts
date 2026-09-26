import { listAgentEntries, listAgentIds } from "../../agents/agent-roster.js";
import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";

/** Lists agent ids whose session stores should be considered configured. */
export function listConfiguredSessionStoreAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set(listAgentIds(cfg).map((agentId) => normalizeAgentId(agentId)));
  const addAcpAgentId = (agentId: string | undefined) => {
    const raw = agentId?.trim() ?? "";
    if (!raw || raw === "*") {
      return;
    }
    ids.add(normalizeAgentId(raw));
  };

  addAcpAgentId(cfg.acp?.defaultAgent);
  for (const agentId of cfg.acp?.allowedAgents ?? []) {
    addAcpAgentId(agentId);
  }
  for (const agent of listAgentEntries(cfg)) {
    if (agent.runtime?.type === "acp") {
      addAcpAgentId(agent.runtime.acp?.agent ?? agent.id);
    }
  }

  return [...ids];
}

/** Checks whether an agent is configured to own a session store. */
export function isConfiguredSessionStoreAgentId(cfg: OpenClawConfig, agentId: string): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (resolveAgentEntry(cfg, normalizedAgentId)) {
    return true;
  }
  return listConfiguredSessionStoreAgentIds(cfg).includes(normalizedAgentId);
}
