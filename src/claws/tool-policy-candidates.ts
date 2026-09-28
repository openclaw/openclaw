import { listAgentEntries } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";

export type ClawToolPolicyCandidate = { agentId: string; agentConfigDigest: string; tools: object };

export function collectClawToolPolicyCandidates(config: OpenClawConfig): ClawToolPolicyCandidate[] {
  return listAgentEntries(config).flatMap((agent) => {
    const tools = agent.tools;
    return tools && (tools.profile || tools.allow?.length)
      ? [{ agentId: agent.id, agentConfigDigest: digestClawAgentConfig(agent), tools }]
      : [];
  });
}
