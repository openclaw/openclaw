import fs from "node:fs";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  type ExecPolicyOverrides,
  type ExecSessionDefaults,
  resolveNodeExecEligibility,
  resolveNodeExecEligibilityAsync,
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
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
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
  resolveSkillCommandInvocation,
} from "./chat-command-invocation.js";

type WorkspaceSkillCommandParams = {
  workspaceDir: string;
  cfg: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
  sessionEntry?: ExecSessionDefaults &
    Pick<SessionEntry, "skillLibrarySelections" | "skillsSnapshot">;
  sessionKey?: string;
  execOverrides?: ExecPolicyOverrides;
  includeAllowlistHidden?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

function resolveWorkspaceSkillCommandOptions(
  params: WorkspaceSkillCommandParams,
  nodeSkills: ReturnType<typeof resolveNodeExecEligibility>,
) {
  const eligibility = {
    nodeSkills,
    remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec }),
  };
  return {
    config: params.cfg,
    agentId: params.agentId,
    skillFilter: params.skillFilter,
    includeAllowlistHidden: params.includeAllowlistHidden,
    eligibility,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    librarySelections: params.sessionEntry?.skillLibrarySelections,
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

/** @deprecated Await prepareSkillCommandsForWorkspace; removed at the next Plugin SDK major. */
export function listSkillCommandsForWorkspace(
  params: WorkspaceSkillCommandParams,
): SkillCommandSpec[] {
  warnPluginSdkDeprecation({
    family: "skill-command-discovery",
    method: "listSkillCommandsForWorkspace",
    replacement: "prepareSkillCommandsForWorkspace",
  });
  return buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
    ...resolveWorkspaceSkillCommandOptions(params, resolveNodeExecEligibility(params)),
    reservedNames: listReservedChatSlashCommandNames(),
    gatewayOnly: hasRemoteWorkspace(params.workspaceDir),
  });
}

export async function prepareSkillCommandsForWorkspace(
  params: WorkspaceSkillCommandParams,
  assertCurrent?: () => void,
): Promise<SkillCommandSpec[]> {
  assertCurrent?.();
  await prepareRemoteSkillConnections();
  assertCurrent?.();
  const nodeSkills = await resolveNodeExecEligibilityAsync(params);
  assertCurrent?.();
  const commands = await prepareWorkspaceSkillCommandSpecs(
    params.workspaceDir,
    {
      ...resolveWorkspaceSkillCommandOptions(params, nodeSkills),
      reservedNames: listReservedChatSlashCommandNames(),
    },
    assertCurrent,
  );
  assertCurrent?.();
  return commands;
}

/** Resolve Gateway-bundled commands with the active Harness eligibility checks. */
export async function prepareBundledSkillCommandForWorkspace(
  params: WorkspaceSkillCommandParams & { skillName: string },
): Promise<SkillCommandSpec | undefined> {
  await prepareRemoteSkillConnections();
  const nodeSkills = await resolveNodeExecEligibilityAsync(params);
  const commands = await prepareWorkspaceSkillCommandSpecs(params.workspaceDir, {
    ...resolveWorkspaceSkillCommandOptions(params, nodeSkills),
    reservedNames: listReservedChatSlashCommandNames(),
    bundledSkillName: params.skillName,
  });
  return commands.find(
    (command) =>
      command.skillSource === "bundled" &&
      command.skillName.trim().toLowerCase() === params.skillName.trim().toLowerCase(),
  );
}

function finalizeSkillCommands(commands: SkillCommandSpec[]): SkillCommandSpec[] {
  const seen = new Set<string>();
  return commands
    .filter((cmd) => {
      const key = normalizeOptionalLowercaseString(cmd.skillName);
      if (key && seen.has(key)) {
        return false;
      }
      if (key) {
        seen.add(key);
      }
      return true;
    })
    .toSorted((left, right) => left.skillName.localeCompare(right.skillName, "en"));
}

type AgentSkillCommandParams = {
  cfg: OpenClawConfig;
  agentIds?: string[];
  sessionEntry?: ExecSessionDefaults &
    Pick<SessionEntry, "skillLibrarySelections" | "skillsSnapshot">;
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
    yield {
      workspaceDir,
      params: {
        cfg: params.cfg,
        agentId,
        workspaceDir,
        skillFilter,
        ...(hasSingleAgentContext
          ? {
              sessionEntry: params.sessionEntry,
              sessionKey: params.sessionKey,
              execOverrides: params.execOverrides,
            }
          : {}),
      },
      gatewayOnly,
    };
  }
}

function appendSkillCommands(
  entries: SkillCommandSpec[],
  used: Set<string>,
  commands: SkillCommandSpec[],
) {
  for (const command of commands) {
    used.add(command.name);
    entries.push(command);
  }
}

/** @deprecated Await prepareSkillCommandsForAgents; removed at the next Plugin SDK major. */
export function listSkillCommandsForAgents(params: AgentSkillCommandParams): SkillCommandSpec[] {
  warnPluginSdkDeprecation({
    family: "skill-command-discovery",
    method: "listSkillCommandsForAgents",
    replacement: "prepareSkillCommandsForAgents",
  });
  const used = listReservedChatSlashCommandNames();
  const entries: SkillCommandSpec[] = [];
  for (const {
    workspaceDir,
    params: workspaceParams,
    gatewayOnly,
  } of resolveAgentSkillCommandWorkspaces(params)) {
    appendSkillCommands(
      entries,
      used,
      buildWorkspaceSkillCommandSpecs(workspaceDir, {
        ...resolveWorkspaceSkillCommandOptions(
          workspaceParams,
          resolveNodeExecEligibility(workspaceParams),
        ),
        gatewayOnly,
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
  for (const {
    workspaceDir,
    params: workspaceParams,
    gatewayOnly,
  } of resolveAgentSkillCommandWorkspaces(params, true)) {
    const nodeSkills = await resolveNodeExecEligibilityAsync(workspaceParams);
    params.signal?.throwIfAborted();
    const commands = await racePromiseWithAbortSignal(
      prepareWorkspaceSkillCommandSpecs(workspaceDir, {
        ...resolveWorkspaceSkillCommandOptions(workspaceParams, nodeSkills),
        gatewayOnly,
        reservedNames: used,
      }),
      params.signal,
    );
    params.signal?.throwIfAborted();
    appendSkillCommands(entries, used, commands);
  }
  return finalizeSkillCommands(entries);
}
