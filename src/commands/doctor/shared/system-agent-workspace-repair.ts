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
  canCarryCliConversation,
  carryClaudeCliConversations,
  cliConversationResumesIn,
  listStoredCliConversations,
  type StoredCliConversation,
} from "./system-agent-cli-conversations.js";
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

function countLabel(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function describeRestore(params: {
  plan: WorkspaceRestorePlan;
  applied: boolean;
  launchDir: string;
  agentDir: string;
}): string[] {
  const from = shortenHomePath(params.launchDir);
  const to = shortenHomePath(params.agentDir);
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
 * Gateway startup runs the system agent's turns in the shared workspace, while an unpinned entry in
 * an explicit roster resolves its persona, bootstrap, and memory files to its own directory.
 * Pin the agent directory, after copying the agent's files there from the shared root. The root is
 * never assigned (it holds sibling workspaces), no file is moved or deleted, a customized file in
 * the agent directory is never replaced, and no pin lands while it would end a stored CLI-backend
 * conversation that Doctor cannot carry to the new directory. Without `applyFiles` the pin is left
 * out whenever files or conversations still have to be carried.
 */
export async function repairSystemAgentWorkspacePin(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    includeOwnsRoster?: boolean;
    authoredDefaultWorkspace?: string;
    /** Copy files now (Doctor repair); otherwise describe the copy and leave the pin out. */
    applyFiles?: boolean;
    listCliConversations?: (agentId: string) => StoredCliConversation[];
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
  let restore: WorkspaceRestorePlan = { copies: [], links: [], conflicts: [] };
  try {
    if (!launchOwned) {
      restore = await planWorkspaceRestore(launchDir, agentDir);
    }
  } catch (error) {
    return {
      ...unchanged,
      warnings: [
        `Could not inspect the workspaces of agent "${agentId}": ${formatErrorMessage(error)}. Set ${configPath} to the directory that holds its files.`,
      ],
    };
  }
  const workspace = authoredAgentWorkspacePin({
    cfg,
    agentId,
    agentDir,
    authoredRoot: options.authoredDefaultWorkspace ?? cfg.agents?.defaults?.workspace,
    env,
  });
  const shownWorkspace =
    workspace.startsWith("~") || containsEnvVarReference(workspace)
      ? workspace
      : shortenHomePath(workspace);
  const copied = [...restore.copies, ...restore.links];
  const copyHint =
    copied.length > 0
      ? ` after copying ${copied.join(", ")} from ${shortenHomePath(launchDir)} into ${shortenHomePath(agentDir)}`
      : "";
  if (options.includeOwnsRoster) {
    return {
      ...unchanged,
      warnings: [
        `Set ${configPath} to ${shownWorkspace} in the included agent roster${copyHint} so its working directory, persona, and memory use one workspace.`,
      ],
    };
  }
  let conversations: StoredCliConversation[];
  try {
    conversations = (
      options.listCliConversations ?? ((id: string) => listStoredCliConversations(cfg, id, env))
    )(agentId).filter((conversation) => cliConversationResumesIn(conversation, launchDir));
  } catch (error) {
    return {
      ...unchanged,
      warnings: [
        `Could not read the stored sessions of agent "${agentId}": ${formatErrorMessage(error)}. Doctor did not set ${configPath}; set it to ${shownWorkspace}${copyHint} so its working directory, persona, and memory use one workspace.`,
      ],
    };
  }
  const stuck = conversations.filter(
    (conversation) => !canCarryCliConversation(conversation, launchDir, agentDir, env),
  );
  if (stuck.length > 0) {
    return {
      ...unchanged,
      warnings: [
        `Agent "${agentId}" works in ${shortenHomePath(launchDir)} but resolves its persona and memory to ${shortenHomePath(agentDir)}. Doctor did not set ${configPath} because ${countLabel(stuck.length, "stored CLI-backend conversation")} of this agent would start fresh, without resuming history, once its working directory changes. Set ${configPath} to ${shownWorkspace}${copyHint} when that is acceptable.`,
      ],
    };
  }
  const carryLines = (applied: boolean) =>
    conversations.length > 0
      ? [
          `${applied ? "Carried" : "Carry"} ${countLabel(conversations.length, "stored Claude CLI conversation")} of agent "${agentId}" to ${shortenHomePath(agentDir)}: ${conversations.length === 1 ? "its transcript is" : "their transcripts are"} copied into that directory's Claude project folder, the originals stay in place, and the next turn resumes with ${conversations.length === 1 ? "its" : "their"} history.`,
        ]
      : [];
  if (options.applyFiles !== true) {
    if (copied.length > 0 || conversations.length > 0) {
      // The config stays unpinned until the copy runs: --fix, or this repair rerun with
      // applyFiles once the operator accepts the preview.
      return {
        ...unchanged,
        restorePending: true,
        changes: [
          ...describeRestore({ plan: restore, applied: false, launchDir, agentDir }),
          `Set ${configPath} to ${workspace} so its working directory, persona, and memory use one workspace.`,
          ...carryLines(false),
        ],
      };
    }
  } else {
    try {
      await applyWorkspaceRestore(launchDir, agentDir, restore);
    } catch (error) {
      return {
        ...unchanged,
        warnings: [
          `Could not copy the files of agent "${agentId}" from ${shortenHomePath(launchDir)} into ${shortenHomePath(agentDir)}: ${formatErrorMessage(error)}. Doctor did not set ${configPath}.`,
        ],
      };
    }
    try {
      await carryClaudeCliConversations(conversations, launchDir, agentDir, env);
    } catch (error) {
      return {
        ...unchanged,
        warnings: [
          `Could not carry the stored Claude CLI conversations of agent "${agentId}" to ${shortenHomePath(agentDir)}: ${formatErrorMessage(error)}. Doctor did not set ${configPath}.`,
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
    changes: [
      ...describeRestore({ plan: restore, applied: true, launchDir, agentDir }),
      `Set ${configPath} to ${workspace} so its working directory, persona, and memory use one workspace.`,
      ...carryLines(true),
    ],
    explicitSetPaths: [["agents", "entries", entryKey, "workspace"]],
  };
}
