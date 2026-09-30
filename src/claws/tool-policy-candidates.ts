import { listAgentEntries } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";

export type ClawToolPolicyCandidate = { agentId: string; agentConfigDigest: string; tools: object };

export function collectClawToolPolicyCandidates(config: OpenClawConfig): ClawToolPolicyCandidate[] {
  return listAgentEntries(config).flatMap((agent) => {
    const tools = agent.tools;
    if (!tools || !(tools.profile || tools.allow?.length)) {
      return [];
    }
    const canonicalAgent = { ...agent, id: normalizeAgentId(agent.id) };
    return [
      {
        agentId: canonicalAgent.id,
        agentConfigDigest: digestClawAgentConfig(canonicalAgent),
        tools,
      },
    ];
  });
}
