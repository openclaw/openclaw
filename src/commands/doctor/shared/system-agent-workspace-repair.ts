// Doctor repair that records one workspace for a system agent whose turns resolve two.
import { listAgentIds } from "../../../agents/agent-roster.js";
import {
  resolveAgentEntry,
  resolveAgentWorkspaceDir,
  tryResolveConfiguredAgentWorkspaceDir,
  tryResolveLegacyCompatibilityAgentId,
} from "../../../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default-path.js";
import { workspaceProfileLooksConfigured } from "../../../agents/workspace.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { shortenHomePath } from "../../../utils.js";
import type { DoctorConfigMutationResult } from "./config-mutation-state.js";

/**
 * Gateway startup runs the system agent's turns in the shared workspace, while an unpinned entry in
 * an explicit roster resolves its persona, bootstrap, and memory files to its own directory.
 * Pin the directory that already holds the agent's files; never guess when both do.
 */
export async function repairSystemAgentWorkspacePin(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: { includeOwnsRoster?: boolean } = {},
): Promise<DoctorConfigMutationResult & { warnings?: string[] }> {
  const unchanged = { config: cfg, changes: [] };
  const agentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const entries = cfg.agents?.entries ?? {};
  const entryKey = Object.keys(entries).find((key) => normalizeAgentId(key) === agentId);
  if (!agentId || !entryKey || resolveAgentEntry(cfg, agentId)?.workspace?.trim()) {
    return unchanged;
  }
  // Mirrors the launch workspace Gateway startup prepares for this agent's turns.
  const launchDir =
    tryResolveConfiguredAgentWorkspaceDir(cfg, env) ?? resolveDefaultAgentWorkspaceDir(env);
  const agentDir = resolveAgentWorkspaceDir(cfg, agentId, env);
  if (launchDir === agentDir) {
    return unchanged;
  }
  const configPath = `agents.entries.${entryKey}.workspace`;
  // Files in a workspace another agent already resolves to belong to that agent.
  const launchOwned = listAgentIds(cfg).some(
    (id) => id !== agentId && resolveAgentWorkspaceDir(cfg, id, env) === launchDir,
  );
  let launchHasFiles: boolean;
  let agentHasFiles: boolean;
  try {
    [launchHasFiles, agentHasFiles] = await Promise.all([
      !launchOwned && workspaceProfileLooksConfigured({ dir: launchDir }),
      workspaceProfileLooksConfigured({ dir: agentDir }),
    ]);
  } catch (error) {
    return {
      ...unchanged,
      warnings: [
        `Could not inspect the workspaces of agent "${agentId}": ${formatErrorMessage(error)}. Set ${configPath} to the directory that holds its files.`,
      ],
    };
  }
  if (launchHasFiles && agentHasFiles) {
    return {
      ...unchanged,
      warnings: [
        `Agent "${agentId}" has workspace files in both ${shortenHomePath(launchDir)} (its working directory) and ${shortenHomePath(agentDir)} (its persona and memory). Doctor left both unchanged; set ${configPath} to the directory to keep.`,
      ],
    };
  }
  const workspace = launchHasFiles ? launchDir : agentDir;
  if (options.includeOwnsRoster) {
    return {
      ...unchanged,
      warnings: [
        `Set ${configPath} to ${shortenHomePath(workspace)} in the included agent roster so its working directory, persona, and memory use one workspace.`,
      ],
    };
  }
  return {
    config: {
      ...cfg,
      agents: {
        ...cfg.agents,
        entries: { ...entries, [entryKey]: { ...entries[entryKey], workspace } },
      },
    },
    changes: [
      `Set ${configPath} to ${shortenHomePath(workspace)}${launchHasFiles ? ", which holds its workspace files," : ""} so its working directory, persona, and memory use one workspace.`,
    ],
  };
}
