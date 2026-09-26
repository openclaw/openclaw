// Agent config mutation helpers wrap retrying config writes for create/update/
// delete flows and surface typed precondition failures to gateway handlers.
import { hasAgentRosterProperty, tryResolveSoleAgentId } from "../../agents/agent-roster.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
  pruneAgentConfig,
} from "../../commands/agents.config.js";
import { mutateConfigFileWithRetry } from "../../config/config.js";
import { inheritLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions.js";
import type { AgentConfig } from "../../config/types.agents.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type AgentDeleteMutationResult = {
  workspaceDir: string;
  agentDir: string;
  sessionsDir: string;
  removedBindings: number;
};

/** Typed precondition failure surfaced by agent mutation handlers as gateway errors. */
export class AgentConfigPreconditionError extends Error {}

export class AgentModelSelectionError extends Error {}

type AgentConfigUpdate = {
  agentId: string;
  name?: string;
  workspace?: string;
  model?: string | null;
  agentRuntime?: string;
  identity?: IdentityConfig;
};

function isModelOnlyUpdate(params: AgentConfigUpdate): boolean {
  return (
    Boolean(params.model) &&
    params.name === undefined &&
    params.workspace === undefined &&
    params.identity === undefined
  );
}

export function validateAgentModelSelectionUpdate(
  params: AgentConfigUpdate & { emoji?: string; avatar?: string },
): string | undefined {
  if (!params.agentRuntime) {
    return undefined;
  }
  if (
    !isModelOnlyUpdate(params) ||
    params.emoji !== undefined ||
    params.avatar !== undefined ||
    !params.model
  ) {
    return "Runtime selection requires a model-only update.";
  }
  if (splitTrailingAuthProfile(params.model).profile) {
    return "Choose a model without an OpenClaw sign-in override for this runtime.";
  }
  return undefined;
}

/** Checks the current config snapshot for a concrete agent entry. */
export function isConfiguredAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

export function isImplicitAgentModelUpdate(
  cfg: OpenClawConfig,
  params: AgentConfigUpdate,
): boolean {
  return (
    !hasAgentRosterProperty(cfg) &&
    tryResolveSoleAgentId(cfg) === params.agentId &&
    isModelOnlyUpdate(params) &&
    params.agentRuntime !== undefined
  );
}

/** Updates an existing agent entry while preserving omitted fields. */
export async function updateAgentConfigEntry(params: AgentConfigUpdate): Promise<void> {
  const selectionError = validateAgentModelSelectionUpdate(params);
  if (selectionError) {
    throw new AgentModelSelectionError(selectionError);
  }
  const selectionModules = params.agentRuntime
    ? await Promise.all([
        import("../../agents/model-runtime-choice.js"),
        import("../../commands/models/shared.js"),
        import("../../system-agent/setup-model-selection.js"),
      ])
    : undefined;
  let validateSelection: (() => string | undefined) | undefined;
  await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    // Identity replacement may intentionally reduce the configuration size.
    writeOptions: {
      ...(params.identity ? { allowConfigSizeDrop: true } : {}),
      assertConfigPathForWrite: () => {
        const error = validateSelection?.();
        if (error) {
          throw new AgentModelSelectionError(error);
        }
      },
    },
    mutate: async (draft) => {
      validateSelection = undefined;
      const configured = isConfiguredAgent(draft, params.agentId);
      if (!configured && !isImplicitAgentModelUpdate(draft, params)) {
        throw new AgentConfigPreconditionError(`agent "${params.agentId}" not found`);
      }
      let next = draft;
      if (params.model && selectionModules) {
        const [runtimeChoice, modelConfig, modelSelection] = selectionModules;
        const target = modelConfig.resolveModelTarget({ raw: params.model, cfg: draft });
        const choice = await runtimeChoice.preparePublishedModelRuntimeChoice({
          cfg: draft,
          agentId: params.agentId,
          provider: target.provider,
          model: target.model,
          runtimeId: params.agentRuntime,
        });
        if (choice.kind === "unavailable") {
          throw new AgentModelSelectionError(choice.message);
        }
        validateSelection = choice.validate;
        next = await modelSelection.applySystemAgentModelSelection({
          config: draft,
          model: params.model,
          agentRuntimeId: choice.runtimeId,
          ...(configured ? { targetAgentId: params.agentId } : { runtimeInDefaults: true }),
        });
      }
      const latestNextConfig = configured
        ? applyAgentConfig(next, {
            agentId: params.agentId,
            ...(params.name ? { name: params.name } : {}),
            ...(params.workspace ? { workspace: params.workspace } : {}),
            ...(!params.agentRuntime && params.model !== undefined ? { model: params.model } : {}),
            ...(params.identity ? { identity: params.identity } : {}),
          })
        : next;
      Object.assign(draft, latestNextConfig);
    },
  });
}

/** Removes an agent entry and returns filesystem roots the caller should clean up. */
export async function deleteAgentConfigEntry(params: {
  agentId: string;
  validate?: (agent: AgentConfig) => void;
  validateConfig?: (config: OpenClawConfig) => void;
  assertCurrent?: () => void;
  allowMissing?: boolean;
  allowConfigSizeDrop?: boolean;
  fallbackWorkspace?: string;
}): Promise<{
  nextConfig: OpenClawConfig;
  result: AgentDeleteMutationResult | undefined;
}> {
  const committed = await mutateConfigFileWithRetry<AgentDeleteMutationResult | undefined>({
    afterWrite: { mode: "auto" },
    writeOptions: {
      allowedAgentRosterRemovals: [params.agentId],
      assertConfigPathForWrite: params.assertCurrent,
      ...(params.allowConfigSizeDrop ? { allowConfigSizeDrop: true } : {}),
    },
    mutate: (draft, context) => {
      // structuredClone drops the WeakMap-backed legacy-owner provenance. Preserve it so preview,
      // validation, pruning, and write preparation resolve the same canonical topology.
      inheritLegacyDefaultAgentId(context.snapshot.config, draft);
      params.validateConfig?.(draft);
      const configured = isConfiguredAgent(draft, params.agentId);
      if (!configured && !params.allowMissing) {
        throw new AgentConfigPreconditionError(`agent "${params.agentId}" not found`);
      }
      const entries = listAgentEntries(draft);
      const agentIndex = findAgentEntryIndex(entries, params.agentId);
      const agent = agentIndex >= 0 ? entries[agentIndex] : undefined;
      if (agent) {
        params.validate?.(agent);
      }
      const workspaceDir = agent
        ? resolveAgentWorkspaceDir(draft, params.agentId)
        : (params.fallbackWorkspace ?? "");
      const agentDir = resolveAgentDir(draft, params.agentId);
      const sessionsDir = resolveSessionTranscriptsDirForAgent(params.agentId);
      const result = pruneAgentConfig(draft, params.agentId);
      Object.assign(draft, result.config);
      if (!agent) {
        return undefined;
      }
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
