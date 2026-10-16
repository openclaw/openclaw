import { realpathSync } from "node:fs";
import { listAgentEntries, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { digestClawOwnedAgentConfig } from "./agent-config-ownership.js";
import { digestClawValue } from "./digest.js";
import { normalizeWorkspaceConfig, resolveMigrationAgentSettings } from "./migrate-validation.js";

export type ClawToolPolicyCandidate = {
  agentId: string;
  agentConfigDigest: string;
  adoptedAgentConfigDigests: (env?: NodeJS.ProcessEnv) => { owned: string; legacy: string };
  legacyAgentConfigDigest: string;
  tools: object;
};

export function collectClawToolPolicyCandidates(config: OpenClawConfig): ClawToolPolicyCandidate[] {
  return listAgentEntries(config).flatMap((agent) => {
    const tools = agent.tools;
    if (!tools || (!tools.profile && !tools.allow?.length)) {
      return [];
    }
    let adoptedDigests: { owned: string; legacy: string } | undefined;
    return [
      {
        agentId: agent.id,
        agentConfigDigest: digestClawOwnedAgentConfig(agent),
        legacyAgentConfigDigest: digestClawValue(agent),
        // Adoption resolves effective settings and the canonical workspace
        // without rewriting authored config. Keep the older full digest readable.
        adoptedAgentConfigDigests: (env) => {
          if (adoptedDigests) {
            return adoptedDigests;
          }
          const effective = normalizeWorkspaceConfig(
            resolveMigrationAgentSettings(config, agent),
            realpathSync(resolveAgentWorkspaceDir(config, agent.id, env)),
          );
          adoptedDigests = {
            owned: digestClawOwnedAgentConfig(effective),
            legacy: digestClawValue(effective),
          };
          return adoptedDigests;
        },
        tools,
      },
    ];
  });
}
