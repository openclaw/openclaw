import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveBootstrapMaxChars } from "../agents/embedded-agent-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type ToolsMdMigrationWorkspaceTarget = {
  primaryAgentId: string;
  agentIds: string[];
  workspaceDir: string;
};

export function resolveToolsMdMigrationWorkspaceTargets(
  cfg: OpenClawConfig,
): ToolsMdMigrationWorkspaceTarget[] {
  const targets = new Map<string, ToolsMdMigrationWorkspaceTarget>();
  for (const agentId of listAgentIds(cfg)) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const key = path.resolve(workspaceDir);
    const target = targets.get(key) ?? { primaryAgentId: agentId, agentIds: [], workspaceDir };
    target.agentIds.push(agentId);
    targets.set(key, target);
  }
  return [...targets.values()];
}

/** One finding per agent whose own bootstrap budget cannot hold the merged file. */
export function describeToolsMdMergedBootstrapLimits(params: {
  cfg: OpenClawConfig;
  agentIds: readonly string[];
  mergedChars: number;
}): Array<{ agentId: string; message: string }> {
  return params.agentIds.flatMap((agentId) => {
    const bootstrapMaxChars = resolveBootstrapMaxChars(params.cfg, agentId);
    if (params.mergedChars <= bootstrapMaxChars) {
      return [];
    }
    return [
      {
        agentId,
        message: `Agent "${agentId}" TOOLS.md migration will produce a ${params.mergedChars}-character AGENTS.md, exceeding its configured bootstrapMaxChars limit of ${bootstrapMaxChars}. Raise \`agents.entries.*.bootstrapMaxChars\` for this agent, or \`agents.defaults.bootstrapMaxChars\` as fallback, to preserve all migrated instructions.`,
      },
    ];
  });
}
