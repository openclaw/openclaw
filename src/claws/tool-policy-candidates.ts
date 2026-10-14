import { realpathSync } from "node:fs";
import { listAgentEntries, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { digestClawValue } from "./digest.js";
import { normalizeWorkspaceConfig, resolveMigrationAgentSettings } from "./migrate-validation.js";

export type ClawToolPolicyCandidate = {
  agentId: string;
  agentConfigDigest: string;
  adoptedAgentConfigDigest: (env?: NodeJS.ProcessEnv) => string;
  tools: object;
};

export function collectClawToolPolicyCandidates(config: OpenClawConfig): ClawToolPolicyCandidate[] {
  return listAgentEntries(config).flatMap((agent) => {
    const tools = agent.tools;
    if (!tools || (!tools.profile && !tools.allow?.length)) {
      return [];
    }
    let adoptedDigest: string | undefined;
    return [
      {
        agentId: agent.id,
        agentConfigDigest: digestClawValue(agent),
        // Adoption binds effective settings and the canonical workspace without
        // rewriting the authored config. Resolve only for known adopted owners,
        // once per prepared candidate, rather than on each tool-policy lookup.
        adoptedAgentConfigDigest: (env) =>
          (adoptedDigest ??= digestClawValue(
            normalizeWorkspaceConfig(
              resolveMigrationAgentSettings(config, agent),
              realpathSync(resolveAgentWorkspaceDir(config, agent.id, env)),
            ),
          )),
        tools,
      },
    ];
  });
}
