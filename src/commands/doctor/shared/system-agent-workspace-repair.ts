// Doctor repair that records one workspace for a system agent whose turns resolve two.
import { listAgentIds } from "../../../agents/agent-roster.js";
import {
  resolveAgentEntry,
  resolveAgentWorkspaceDir,
  tryResolveConfiguredAgentWorkspaceDir,
  tryResolveLegacyCompatibilityAgentId,
} from "../../../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default-path.js";
import { containsEnvVarReference, resolveConfigEnvVars } from "../../../config/env-substitution.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { shortenHomePath } from "../../../utils.js";
import type { DoctorConfigMutationResult } from "./config-mutation-state.js";
import {
  applyWorkspaceRestore,
  planWorkspaceRestore,
  type WorkspaceRestorePlan,
} from "./system-agent-workspace-restore.js";

/**
 * Pin `<root>/<agentId>` with the root spelled as authored (`${VAR}`, `~/x`) so a later change
 * to the root moves defaults and pin together; fall back to the resolved path when the authored
 * spelling does not resolve to the same directory.
 */
function authoredAgentWorkspacePin(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  authoredRoot: string | undefined;
  env: NodeJS.ProcessEnv;
}): string {
  const authored = params.authoredRoot?.trim();
  if (!authored) {
    return params.agentDir;
  }
  const pin = `${authored.replace(/[\\/]+$/, "")}/${params.agentId}`;
  try {
    const resolved = containsEnvVarReference(pin)
      ? resolveConfigEnvVars(pin, params.env, { onMissing: () => {} })
      : pin;
    const resolvedPin = typeof resolved === "string" ? resolved : pin;
    const probe: OpenClawConfig = {
      ...params.cfg,
      agents: {
        ...params.cfg.agents,
        entries: { ...params.cfg.agents?.entries, [params.agentId]: { workspace: resolvedPin } },
      },
    };
    return resolveAgentWorkspaceDir(probe, params.agentId, params.env) === params.agentDir
      ? pin
      : params.agentDir;
  } catch {
    return params.agentDir;
  }
}

function describeRestore(params: {
  plan: WorkspaceRestorePlan;
  applied: boolean;
  from: string;
  to: string;
}): string[] {
  const from = shortenHomePath(params.from);
  const to = shortenHomePath(params.to);
  const lines: string[] = [];
  const copied = [...params.plan.copies, ...params.plan.links];
  if (copied.length > 0) {
    lines.push(
      `${params.applied ? "Copied" : "Copy"} ${copied.join(", ")} from ${from} into ${to}; the files in ${from} stay in place.`,
    );
  }
  if (params.plan.conflicts.length > 0) {
    lines.push(
      `Kept ${params.plan.conflicts.join(", ")} in ${to}; the different copies in ${from} stay in place.`,
    );
  }
  return lines;
}

/**
 * An unpinned system agent in an explicit roster resolves its persona, bootstrap, and memory files
 * to its own directory, while its files may sit in the launch workspace. Doctor pins one of the two
 * after copying the agent's files into it. With `agents.defaults.workspace` set, the Gateway already
 * runs the agent in its own directory and the root holds sibling workspaces, so that directory is
 * pinned. Without it, the Gateway runs the agent in the launch workspace, which is pinned so the
 * working directory does not move; when another agent owns that workspace, Doctor only warns. No file is moved or deleted and a customized file in the pinned
 * directory is never replaced. Without `applyFiles` the pin is left out while files must be copied.
 */
export async function repairSystemAgentWorkspacePin(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    includeOwnsRoster?: boolean;
    authoredDefaultWorkspace?: string;
    /** Copy files now (Doctor repair); otherwise describe the copy and leave the pin out. */
    applyFiles?: boolean;
  } = {},
): Promise<
  DoctorConfigMutationResult & {
    warnings?: string[];
    explicitSetPaths?: string[][];
    /** Rerun with `applyFiles` once the operator confirms; this preview left the pin out. */
    restorePending?: true;
  }
> {
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
  const keepLaunch = !cfg.agents?.defaults?.workspace?.trim();
  if (keepLaunch && launchOwned) {
    // Either pin would move the Gateway working directory, ending stored CLI conversations.
    return {
      ...unchanged,
      warnings: [
        `Agent "${agentId}" works in ${shortenHomePath(launchDir)}, which another agent owns, but resolves its persona and memory to ${shortenHomePath(agentDir)}. Doctor did not set ${configPath}; set it to the directory that should hold its files.`,
      ],
    };
  }
  const [from, to] = keepLaunch ? [agentDir, launchDir] : [launchDir, agentDir];
  let restore: WorkspaceRestorePlan = { copies: [], links: [], conflicts: [] };
  try {
    if (!launchOwned) {
      restore = await planWorkspaceRestore(from, to);
    }
  } catch (error) {
    return {
      ...unchanged,
      warnings: [
        `Could not inspect the workspaces of agent "${agentId}": ${formatErrorMessage(error)}. Set ${configPath} to the directory that holds its files.`,
      ],
    };
  }
  const workspace = keepLaunch
    ? to
    : authoredAgentWorkspacePin({
        cfg,
        agentId,
        agentDir,
        authoredRoot: options.authoredDefaultWorkspace ?? cfg.agents?.defaults?.workspace,
        env,
      });
  const copied = [...restore.copies, ...restore.links];
  const pinLine = `Set ${configPath} to ${workspace} so its working directory, persona, and memory use one workspace.`;
  if (options.includeOwnsRoster) {
    const shownWorkspace =
      workspace.startsWith("~") || containsEnvVarReference(workspace)
        ? workspace
        : shortenHomePath(workspace);
    const copyHint =
      copied.length > 0
        ? ` after copying ${copied.join(", ")} from ${shortenHomePath(from)} into ${shortenHomePath(to)}`
        : "";
    return {
      ...unchanged,
      warnings: [
        `Set ${configPath} to ${shownWorkspace} in the included agent roster${copyHint} so its working directory, persona, and memory use one workspace.`,
      ],
    };
  }
  if (options.applyFiles !== true) {
    if (copied.length > 0) {
      // The config stays unpinned until the copy runs: --fix, or this repair rerun with
      // applyFiles once the operator accepts the preview.
      return {
        ...unchanged,
        restorePending: true,
        changes: [...describeRestore({ plan: restore, applied: false, from, to }), pinLine],
      };
    }
  } else {
    try {
      await applyWorkspaceRestore(from, to, restore);
    } catch (error) {
      return {
        ...unchanged,
        warnings: [
          `Could not copy the files of agent "${agentId}" from ${shortenHomePath(from)} into ${shortenHomePath(to)}: ${formatErrorMessage(error)}. Doctor did not set ${configPath}.`,
        ],
      };
    }
  }
  return {
    config: {
      ...cfg,
      agents: {
        ...cfg.agents,
        entries: { ...entries, [entryKey]: { ...entries[entryKey], workspace } },
      },
    },
    changes: [...describeRestore({ plan: restore, applied: true, from, to }), pinLine],
    explicitSetPaths: [["agents", "entries", entryKey, "workspace"]],
  };
}
