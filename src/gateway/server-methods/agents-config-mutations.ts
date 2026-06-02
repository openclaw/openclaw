import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
  pruneAgentConfig,
} from "../../commands/agents.config.js";
import { mutateConfigFileWithRetry } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isValidAgentId, normalizeAgentId } from "../../routing/session-key.js";

export type AgentDeleteMutationResult = {
  workspaceDir: string;
  agentDir: string;
  sessionsDir: string;
  removedBindings: number;
};

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

/** Typed precondition failure surfaced by agent mutation handlers as gateway errors. */
export class AgentConfigPreconditionError extends Error {
  constructor(
    readonly kind: "already-exists" | "not-found",
    readonly agentId: string,
  ) {
    super(
      kind === "already-exists"
        ? `agent "${agentId}" already exists`
        : `agent "${agentId}" not found`,
    );
    this.name = "AgentConfigPreconditionError";
  }
}

/** Checks the current config snapshot for a concrete agent entry. */
export function isConfiguredAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

function normalizeAllowAgents(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed !== "*" && !isValidAgentId(trimmed)) {
      continue;
    }
    const id = trimmed === "*" ? "*" : normalizeAgentId(trimmed);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizePatchTargets(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const id = trimmed === "*" || !isValidAgentId(trimmed) ? trimmed : normalizeAgentId(trimmed);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function readEffectiveAllowAgents(cfg: OpenClawConfig, entry: AgentEntry): string[] {
  const allowAgents = entry.subagents?.allowAgents ?? cfg.agents?.defaults?.subagents?.allowAgents;
  return Array.isArray(allowAgents) ? allowAgents : [];
}

export async function patchAgentSubagentAllowAgents(params: {
  agentId: string;
  addAllowAgents: string[];
}): Promise<string[]> {
  const committed = await mutateConfigFileWithRetry<string[]>({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const list = listAgentEntries(draft);
      const requesterIndex = findAgentEntryIndex(list, params.agentId);
      if (requesterIndex < 0) {
        throw new AgentConfigPreconditionError("not-found", params.agentId);
      }

      const targetIds = normalizePatchTargets(params.addAllowAgents);
      for (const targetId of targetIds) {
        if (
          targetId === "*" ||
          !isValidAgentId(targetId) ||
          findAgentEntryIndex(list, targetId) < 0
        ) {
          throw new AgentConfigPreconditionError("not-found", targetId);
        }
      }

      const requester = list[requesterIndex];
      const allowAgents = normalizeAllowAgents([
        ...readEffectiveAllowAgents(draft, requester),
        ...targetIds,
      ]);
      list[requesterIndex] = {
        ...requester,
        subagents: {
          ...requester.subagents,
          allowAgents,
        },
      };
      draft.agents = {
        ...draft.agents,
        list,
      };
      return allowAgents;
    },
  });
  return committed.result ?? [];
}

/** Adds a new agent entry through the retrying config mutation path. */
export async function createAgentConfigEntry(params: {
  agentId: string;
  name: string;
  workspace: string;
  model?: string;
  identity?: IdentityConfig;
  agentDir: string;
}): Promise<void> {
  await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (isConfiguredAgent(draft, params.agentId)) {
        throw new AgentConfigPreconditionError("already-exists", params.agentId);
      }
      const latestNextConfig = applyAgentConfig(draft, {
        agentId: params.agentId,
        name: params.name,
        workspace: params.workspace,
        model: params.model,
        identity: params.identity,
        agentDir: params.agentDir,
      });
      Object.assign(draft, latestNextConfig);
    },
  });
}

/** Updates an existing agent entry while preserving omitted fields. */
export async function updateAgentConfigEntry(params: {
  agentId: string;
  name?: string;
  workspace?: string;
  model?: string;
  identity?: IdentityConfig;
}): Promise<void> {
  await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (!isConfiguredAgent(draft, params.agentId)) {
        throw new AgentConfigPreconditionError("not-found", params.agentId);
      }
      const latestNextConfig = applyAgentConfig(draft, {
        agentId: params.agentId,
        ...(params.name ? { name: params.name } : {}),
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.identity ? { identity: params.identity } : {}),
      });
      Object.assign(draft, latestNextConfig);
    },
  });
}

/** Removes an agent entry and returns filesystem roots the caller should clean up. */
export async function deleteAgentConfigEntry(params: { agentId: string }): Promise<{
  nextConfig: OpenClawConfig;
  result: AgentDeleteMutationResult | undefined;
}> {
  const committed = await mutateConfigFileWithRetry<AgentDeleteMutationResult>({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (!isConfiguredAgent(draft, params.agentId)) {
        throw new AgentConfigPreconditionError("not-found", params.agentId);
      }
      const workspaceDir = resolveAgentWorkspaceDir(draft, params.agentId);
      const agentDir = resolveAgentDir(draft, params.agentId);
      const sessionsDir = resolveSessionTranscriptsDirForAgent(params.agentId);
      const result = pruneAgentConfig(draft, params.agentId);
      Object.assign(draft, result.config);
      return {
        workspaceDir,
        agentDir,
        sessionsDir,
        removedBindings: result.removedBindings,
      };
    },
  });
  return {
    nextConfig: committed.nextConfig,
    result: committed.result,
  };
}
