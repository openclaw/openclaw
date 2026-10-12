// Doctor repair that records one workspace for a system agent whose turns resolve two.
import fs from "node:fs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds } from "../../../agents/agent-roster.js";
import {
  resolveAgentEntry,
  resolveAgentWorkspaceDir,
  tryResolveConfiguredAgentWorkspaceDir,
  tryResolveLegacyCompatibilityAgentId,
} from "../../../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default-path.js";
import {
  workspaceProfileLooksConfigured,
  workspaceRequiredBootstrapLooksCustomized,
} from "../../../agents/workspace.js";
import { containsEnvVarReference, resolveConfigEnvVars } from "../../../config/env-substitution.js";
import { getCliSessionBinding } from "../../../config/sessions/cli-session-binding.js";
import { scanDoctorSessionEntriesTolerant } from "../../../config/sessions/session-accessor.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { loadLegacySessionStore } from "../../../infra/state-migrations.legacy-session-store.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";
import { shortenHomePath } from "../../../utils.js";
import type { DoctorConfigMutationResult } from "./config-mutation-state.js";

/** Customized profile, memory, skills, or AGENTS.md all count as files the agent owns. */
async function workspaceHoldsAgentFiles(dir: string): Promise<boolean> {
  const [profile, agents] = await Promise.all([
    workspaceProfileLooksConfigured({ dir }),
    workspaceRequiredBootstrapLooksCustomized(dir),
  ]);
  return profile || agents;
}

function holdsCliConversation(entry: SessionEntry): boolean {
  const providers = [
    ...Object.keys(entry.cliSessionBindings ?? {}),
    ...Object.keys(entry.cliSessionIds ?? {}),
  ];
  return (
    providers.some((provider) => getCliSessionBinding(entry, provider)) ||
    normalizeOptionalString(entry.claudeCliSessionId) !== undefined
  );
}

/**
 * Counts the agent's stored sessions bound to a CLI-backend conversation. The binding records the
 * working directory it started in, so changing that directory starts the conversation fresh.
 */
function countStoredCliConversations(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv,
): number {
  const sessionKeys = new Set<string>();
  const visit = (sessionKey: string, entry: SessionEntry, storeAgentId: string) => {
    const owner = parseAgentSessionKey(sessionKey)?.agentId ?? storeAgentId;
    if (normalizeAgentId(owner) === agentId && holdsCliConversation(entry)) {
      sessionKeys.add(sessionKey);
    }
  };
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
    scanDoctorSessionEntriesTolerant(
      { agentId: target.agentId, env, storePath: target.storePath },
      ({ entry, sessionKey }) => visit(sessionKey, entry, target.agentId),
    );
    if (!target.storePath.endsWith(".sqlite") && fs.existsSync(target.storePath)) {
      for (const [sessionKey, entry] of Object.entries(loadLegacySessionStore(target.storePath))) {
        if (entry && typeof entry === "object") {
          visit(sessionKey, entry, target.agentId);
        }
      }
    }
  }
  return sessionKeys.size;
}

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

/**
 * Gateway startup runs the system agent's turns in the shared workspace, while an unpinned entry in
 * an explicit roster resolves its persona, bootstrap, and memory files to its own directory.
 * Pin the agent directory when it is the only place files live; never assign the shared root,
 * never guess when the root holds files, and never restart a stored CLI-backend conversation.
 */
export async function repairSystemAgentWorkspacePin(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    includeOwnsRoster?: boolean;
    authoredDefaultWorkspace?: string;
    countCliConversations?: (agentId: string) => number;
  } = {},
): Promise<DoctorConfigMutationResult & { warnings?: string[]; explicitSetPaths?: string[][] }> {
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
      !launchOwned && workspaceHoldsAgentFiles(launchDir),
      workspaceHoldsAgentFiles(agentDir),
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
  if (launchHasFiles) {
    return {
      ...unchanged,
      warnings: [
        `Agent "${agentId}" has workspace files in ${shortenHomePath(launchDir)} (its working directory) but resolves its persona and memory to ${shortenHomePath(agentDir)}. Doctor did not pick a workspace for it; set ${configPath} to ${shortenHomePath(launchDir)} to keep the files in place, or to ${shortenHomePath(agentDir)} after moving them there.`,
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
  if (options.includeOwnsRoster) {
    return {
      ...unchanged,
      warnings: [
        `Set ${configPath} to ${shownWorkspace} in the included agent roster so its working directory, persona, and memory use one workspace.`,
      ],
    };
  }
  let cliConversations: number;
  try {
    cliConversations = (
      options.countCliConversations ?? ((id: string) => countStoredCliConversations(cfg, id, env))
    )(agentId);
  } catch (error) {
    return {
      ...unchanged,
      warnings: [
        `Could not read the stored sessions of agent "${agentId}": ${formatErrorMessage(error)}. Doctor did not set ${configPath}; set it to ${shownWorkspace} so its working directory, persona, and memory use one workspace.`,
      ],
    };
  }
  if (cliConversations > 0) {
    const conversations =
      cliConversations === 1
        ? "1 stored CLI-backend conversation"
        : `${cliConversations} stored CLI-backend conversations`;
    return {
      ...unchanged,
      warnings: [
        `Agent "${agentId}" works in ${shortenHomePath(launchDir)} but resolves its persona and memory to ${shortenHomePath(agentDir)}. Doctor did not set ${configPath} because ${conversations} of this agent would start fresh, without resuming history, once its working directory changes. Set ${configPath} to ${shownWorkspace} when that is acceptable.`,
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
      `Set ${configPath} to ${workspace} so its working directory, persona, and memory use one workspace.`,
    ],
    explicitSetPaths: [["agents", "entries", entryKey, "workspace"]],
  };
}
