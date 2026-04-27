import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  parseModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveDefaultModel(params: { cfg: OpenClawConfig; agentId?: string }): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const mainModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
  });
  return { defaultProvider, defaultModel, aliasIndex };
}

// For subagent sessions (entry.subagentRole set or entry.spawnDepth >= 1) the
// reply runtime would otherwise start the run on the parent agent's
// `model.primary` and then post-run write that model back into the session
// entry, clobbering the configured subagent default that
// `resolveSubagentSpawnModelSelection` wrote at spawn time. This helper resolves
// the configured subagent default (agentConfig.subagents.model →
// defaults.subagents.model → agentConfig.model) so the Pi runtime harness can
// boot the run on the right model.
export function resolveSubagentSessionDefaultModel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionEntry?: Pick<SessionEntry, "spawnDepth" | "subagentRole">;
  defaultProvider: string;
}): { provider: string; model: string } | null {
  const isSubagent =
    (typeof params.sessionEntry?.spawnDepth === "number" && params.sessionEntry.spawnDepth >= 1) ||
    Boolean(params.sessionEntry?.subagentRole);
  if (!isSubagent || !params.agentId) {
    return null;
  }
  const subagentSelection = resolveSubagentConfiguredModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!subagentSelection) {
    return null;
  }
  const ref = parseModelRef(subagentSelection, params.defaultProvider);
  return ref ? { provider: ref.provider, model: ref.model } : null;
}
