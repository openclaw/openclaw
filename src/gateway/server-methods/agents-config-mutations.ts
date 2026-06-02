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

export type AgentDeleteMutationResult = {
  workspaceDir: string;
  agentDir: string;
  sessionsDir: string;
  removedBindings: number;
};

/**
 * Typed precondition failure for config mutations that require a specific agent
 * presence state. Gateway handlers convert the kind into stable RPC errors
 * without parsing exception messages.
 */
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

/**
 * Check whether a config snapshot contains an agent entry with this id. This is
 * intentionally snapshot-only so callers can use it inside retrying config
 * mutations without performing a second disk read.
 */
export function isConfiguredAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

/**
 * Add a new agent entry through the retrying config mutation path. The
 * precondition is checked inside the write transaction so concurrent edits
 * cannot create duplicate agent ids.
 */
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

/**
 * Update an existing agent entry while preserving omitted fields. Empty optional
 * fields are treated as absent; callers that need clearing semantics must use a
 * more explicit config mutation.
 */
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

/**
 * Remove an agent entry and return the filesystem roots the caller should clean
 * up after the config write succeeds. Cleanup stays outside the mutation so a
 * failed write cannot delete still-referenced agent data.
 */
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
