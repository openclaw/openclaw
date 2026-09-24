// Skill chat command discovery loads chat commands contributed by active skills.
import fs from "node:fs";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  type ExecPolicyOverrides,
  type ExecSessionDefaults,
  resolveNodeExecEligibility,
} from "../../agents/exec-defaults.js";
import {
  getAgentWorkspaceAccess,
  isWorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveSessionSkillWorkspaceDir } from "../loading/workspace-skill-roots.js";
import { prepareRemoteSkillConnections } from "../runtime/remote-skills.js";
import { getRemoteSkillEligibility } from "../runtime/remote.js";
import type { SkillCommandSpec } from "../types.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import { listReservedChatSlashCommandNames } from "./chat-command-invocation.js";
import {
  buildWorkspaceSkillCommandSpecs,
  prepareWorkspaceSkillCommandSpecs,
} from "./command-specs.js";
export {
  expandExplicitSkillReferences,
  hasSkillReferenceCandidate,
  listReservedChatSlashCommandNames,
  resolveSkillCommandInvocation,
} from "./chat-command-invocation.js";

type WorkspaceSkillCommandParams = {
  workspaceDir: string;
  cfg: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
  sessionEntry?: ExecSessionDefaults &
    Pick<
      SessionEntry,
      | "skillLibrarySelections"
      | "skillsSnapshot"
      | "worktree"
      | "spawnedCwd"
      | "spawnedWorkspaceDir"
    >;
  sessionKey?: string;
  execOverrides?: ExecPolicyOverrides;
  includeAllowlistHidden?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

function resolveWorkspaceSkillCommandOptions(params: WorkspaceSkillCommandParams) {
  const nodeSkills = resolveNodeExecEligibility({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
  });
  const eligibility = {
    nodeSkills,
    remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec }),
  };
  return {
    config: params.cfg,
    executionWorkspaceDir: resolveSessionSkillWorkspaceDir(params.sessionEntry),
    agentId: params.agentId,
    skillFilter: params.skillFilter,
    includeAllowlistHidden: params.includeAllowlistHidden,
    eligibility,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    librarySelections: params.sessionEntry?.skillLibrarySelections,
    reservedNames: listReservedChatSlashCommandNames(),
  };
}

// Native menus use Gateway-owned Skills only when a workspace is remote. A stopped
// binding still denotes a remote workspace; it must not expose a stale local copy.
function hasRemoteWorkspace(workspaceDir: string): boolean {
  try {
    return Boolean(getAgentWorkspaceAccess(workspaceDir, "loadSkills")?.loadSkills);
  } catch (error) {
    if (isWorkspaceAccessUnavailableError(error)) {
      return true;
    }
    throw error;
  }
}

/** Synchronous public SDK contract; remote workspace menus are deferred. */
export function listSkillCommandsForWorkspace(
  params: WorkspaceSkillCommandParams,
): SkillCommandSpec[] {
  return buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
    ...resolveWorkspaceSkillCommandOptions(params),
    gatewayOnly: hasRemoteWorkspace(params.workspaceDir),
  });
}

export async function prepareSkillCommandsForWorkspace(
  params: WorkspaceSkillCommandParams,
): Promise<SkillCommandSpec[]> {
  await prepareRemoteSkillConnections();
  return prepareWorkspaceSkillCommandSpecs(
    params.workspaceDir,
    resolveWorkspaceSkillCommandOptions(params),
  );
}

/** Resolve Gateway-bundled commands with the active Harness eligibility checks. */
export async function prepareBundledSkillCommandForWorkspace(
  params: WorkspaceSkillCommandParams & { skillName: string },
): Promise<SkillCommandSpec | undefined> {
  await prepareRemoteSkillConnections();
  const commands = await prepareWorkspaceSkillCommandSpecs(params.workspaceDir, {
    ...resolveWorkspaceSkillCommandOptions(params),
    bundledSkillName: params.skillName,
  });
  return commands.find(
    (command) =>
      command.skillSource === "bundled" &&
      command.skillName.trim().toLowerCase() === params.skillName.trim().toLowerCase(),
  );
}

function dedupeBySkillName(commands: SkillCommandSpec[]): SkillCommandSpec[] {
  const seen = new Set<string>();
  const out: SkillCommandSpec[] = [];
  for (const cmd of commands) {
    const key = normalizeOptionalLowercaseString(cmd.skillName);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    out.push(cmd);
  }
  return out;
}

type AgentSkillCommandParams = {
  cfg: OpenClawConfig;
  agentIds?: string[];
  sessionEntry?: ExecSessionDefaults &
    Pick<
      SessionEntry,
      | "skillLibrarySelections"
      | "skillsSnapshot"
      | "worktree"
      | "spawnedCwd"
      | "spawnedWorkspaceDir"
    >;
  sessionKey?: string;
  execOverrides?: ExecPolicyOverrides;
};

function* resolveAgentSkillCommandWorkspaces(params: AgentSkillCommandParams, allowRemote = false) {
  const agentIds = params.agentIds ?? listAgentIds(params.cfg);
  const hasSingleAgentContext = agentIds.length === 1;
  const workspaceAgents: Array<{
    agentId: string;
    workspaceDir: string;
    skillFilter?: string[];
    gatewayOnly: boolean;
  }> = [];
  for (const agentId of agentIds) {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const remote = allowRemote
      ? Boolean(getAgentWorkspaceAccess(workspaceDir, "loadSkills")?.loadSkills)
      : hasRemoteWorkspace(workspaceDir);
    if (!remote) {
      if (!fs.existsSync(workspaceDir)) {
        logVerbose(`Skipping agent "${agentId}": workspace does not exist: ${workspaceDir}`);
        continue;
      }
      try {
        fs.realpathSync(workspaceDir);
      } catch {
        logVerbose(`Skipping agent "${agentId}": cannot resolve workspace: ${workspaceDir}`);
        continue;
      }
    }
    workspaceAgents.push({
      agentId,
      workspaceDir,
      gatewayOnly: remote && !allowRemote,
      skillFilter: resolveEffectiveAgentSkillFilter(params.cfg, agentId),
    });
  }

  for (const { agentId, workspaceDir, skillFilter, gatewayOnly } of workspaceAgents) {
    const nodeSkills = resolveNodeExecEligibility({
      cfg: params.cfg,
      agentId,
      ...(hasSingleAgentContext
        ? {
            sessionEntry: params.sessionEntry,
            sessionKey: params.sessionKey,
            execOverrides: params.execOverrides,
          }
        : {}),
    });
    yield {
      workspaceDir,
      options: {
        gatewayOnly,
        config: params.cfg,
        executionWorkspaceDir: hasSingleAgentContext
          ? resolveSessionSkillWorkspaceDir(params.sessionEntry)
          : undefined,
        agentId,
        skillFilter,
        librarySelections: hasSingleAgentContext
          ? params.sessionEntry?.skillLibrarySelections
          : undefined,
        eligibility: {
          nodeSkills,
          remote: getRemoteSkillEligibility({
            advertiseExecNode: nodeSkills.canExec,
          }),
        },
      },
    };
  }
}

function appendSkillCommands(
  entries: SkillCommandSpec[],
  used: Set<string>,
  commands: SkillCommandSpec[],
) {
  for (const command of commands) {
    used.add(normalizeLowercaseStringOrEmpty(command.name));
    entries.push(command);
  }
}

function finalizeSkillCommands(entries: SkillCommandSpec[]) {
  return dedupeBySkillName(entries).toSorted((left, right) =>
    left.skillName.localeCompare(right.skillName, "en"),
  );
}

/** Synchronous public SDK contract for native command consumers. */
export function listSkillCommandsForAgents(params: AgentSkillCommandParams): SkillCommandSpec[] {
  const used = listReservedChatSlashCommandNames();
  const entries: SkillCommandSpec[] = [];
  for (const { workspaceDir, options } of resolveAgentSkillCommandWorkspaces(params)) {
    appendSkillCommands(
      entries,
      used,
      buildWorkspaceSkillCommandSpecs(workspaceDir, {
        ...options,
        reservedNames: used,
      }),
    );
  }
  return finalizeSkillCommands(entries);
}

export async function prepareSkillCommandsForAgents(
  params: AgentSkillCommandParams & { signal?: AbortSignal },
): Promise<SkillCommandSpec[]> {
  params.signal?.throwIfAborted();
  await prepareRemoteSkillConnections();
  params.signal?.throwIfAborted();
  const used = listReservedChatSlashCommandNames();
  const entries: SkillCommandSpec[] = [];
  for (const { workspaceDir, options } of resolveAgentSkillCommandWorkspaces(params, true)) {
    const commands = await racePromiseWithAbortSignal(
      prepareWorkspaceSkillCommandSpecs(workspaceDir, {
        ...options,
        reservedNames: used,
      }),
      params.signal,
    );
    params.signal?.throwIfAborted();
    appendSkillCommands(entries, used, commands);
  }
  return finalizeSkillCommands(entries);
}
