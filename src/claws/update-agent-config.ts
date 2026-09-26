import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveClawAgentRosterKey } from "./agent-adoption-apply.js";

/** Replaces one Claw-managed agent while preserving the complete effective roster. */
export function replaceClawUpdateAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  replacement?: AgentConfig;
}): OpenClawConfig {
  const targetKey = resolveClawAgentRosterKey(params.config, params.agentId);
  const retained = listAgentEntries(params.config).filter((agent) => agent.id !== targetKey);
  const entries = params.replacement ? [...retained, params.replacement] : retained;
  const agents = { ...params.config.agents, entries: toAgentEntriesRecord(entries) };
  delete agents.list;
  return { ...params.config, agents };
}
