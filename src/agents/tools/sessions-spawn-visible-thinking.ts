import type { ThinkLevel, ThinkingCatalogEntry } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadGatewayModelCatalogSnapshot } from "../../gateway/server-model-catalog.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { findModelCatalogEntry } from "../model-catalog-lookup.js";
import { selectModelCatalogRuntimeEntry } from "../model-catalog-view.js";
import type { ModelCatalogSnapshot } from "../model-catalog.types.js";
import {
  resolveSubagentModelAndThinkingPlan,
  splitModelRef,
} from "../subagents/spawn/subagent-spawn-plan.js";
import { resolveRequesterPreferences } from "../subagents/spawn/subagent-spawn-requester-prefs.js";
import {
  resolveCandidateThinkingLevel,
  resolveEffectiveAgentRuntime,
} from "../thinking-runtime.js";

/**
 * `sessions.create` validates thinking against the concrete runtime row it
 * selects from `routeVariants`, so the clamp needs the whole prepared snapshot
 * rather than a bare row list.
 */
export type VisibleChildModelCatalogLoader = (params: {
  agentId: string;
  getConfig: () => OpenClawConfig;
}) => Promise<ModelCatalogSnapshot | undefined>;

/**
 * Reads the same prepared catalog generation `sessions.create` validates against,
 * so a saved or inherited level is clamped with the child's real capabilities. An
 * unreadable catalog yields `undefined`: the caller then forwards no explicit
 * level instead of one it could not authorize.
 */
async function loadVisibleChildThinkingCatalog(params: {
  loadModelCatalog?: VisibleChildModelCatalogLoader;
  agentId: string;
  cfg: OpenClawConfig;
}): Promise<ModelCatalogSnapshot | undefined> {
  try {
    return (
      (await (params.loadModelCatalog ?? loadGatewayModelCatalogSnapshot)({
        agentId: params.agentId,
        getConfig: () => params.cfg,
      })) ?? undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Mirrors Gateway's capability owner selection (`projectSessionsPatchEntry`):
 * the logical row identifies the model and owns the configured reasoning
 * policy, then the concrete row for the runtime that will own the child's turn
 * supplies the thinking capabilities. Grading against the logical row instead
 * keeps levels the validator rejects (creation fails where an omitted level
 * used to succeed) and drops levels the selected runtime does support.
 *
 * The selected row carries only its own capabilities, so its `reasoning` flag
 * cannot stand in for the logical policy: `sessions.create` grades with
 * `logical.configuredReasoning ?? logical.reasoning` on top of the selected
 * row. Returning that policy alongside the row keeps the clamp and the
 * validator from disagreeing in either direction.
 */
function selectVisibleChildThinkingCatalog(params: {
  catalog: ModelCatalogSnapshot;
  provider: string;
  modelId: string;
  agentRuntime: string;
}): { catalog: ThinkingCatalogEntry[]; configuredReasoning?: boolean } {
  const logical = findModelCatalogEntry(params.catalog.entries, {
    provider: params.provider,
    modelId: params.modelId,
  });
  if (!logical) {
    return { catalog: params.catalog.entries };
  }
  const selected = selectModelCatalogRuntimeEntry({
    entry: logical,
    routeVariants: params.catalog.routeVariants,
    runtimeId: params.agentRuntime,
  }).entry;
  return {
    catalog: [selected],
    configuredReasoning: logical.configuredReasoning ?? logical.reasoning,
  };
}

/**
 * Resolves the thinking level a visible child is created with.
 *
 * Visible spawns reject per-call `thinking`, so `level` is always a saved
 * subagent/agent default or the caller's inherited level, never an explicit
 * request. `sessions.create` rejects an explicit thinkingLevel its prepared
 * catalog does not support, and only clamps silently when the field is absent,
 * so both sources are clamped to the child's capabilities: forwarding an
 * unsupported saved or inherited level would fail a spawn that the shipped
 * omitted-field path created. Catalog-only restrictions (`reasoning: false`)
 * are invisible without the catalog, so an unreadable catalog or an
 * unsplittable model ref yields `undefined` and the field is omitted.
 */
async function resolveVisibleChildThinkingLevel(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  resolvedModel: string;
  level: ThinkLevel | undefined;
  loadModelCatalog?: VisibleChildModelCatalogLoader;
}): Promise<ThinkLevel | undefined> {
  const { cfg, targetAgentId, level } = params;
  if (!level) {
    return undefined;
  }
  const thinkingCatalog = await loadVisibleChildThinkingCatalog({
    loadModelCatalog: params.loadModelCatalog,
    agentId: targetAgentId,
    cfg,
  });
  if (!thinkingCatalog) {
    return undefined;
  }
  const { provider, model } = splitModelRef(params.resolvedModel);
  if (!provider || !model) {
    return undefined;
  }
  const pendingSessionKey = `agent:${targetAgentId}:dashboard:pending`;
  // Resolve the runtime once so row selection and level grading can never
  // disagree about which harness owns the child's turn.
  const agentRuntime = resolveEffectiveAgentRuntime({
    cfg,
    provider,
    modelId: model,
    agentId: targetAgentId,
    sessionKey: pendingSessionKey,
  });
  const graded = selectVisibleChildThinkingCatalog({
    catalog: thinkingCatalog,
    provider,
    modelId: model,
    agentRuntime,
  });
  return resolveCandidateThinkingLevel({
    cfg,
    provider,
    modelId: model,
    level,
    catalog: graded.catalog,
    configuredReasoning: graded.configuredReasoning,
    agentId: targetAgentId,
    sessionKey: pendingSessionKey,
    agentRuntime,
  });
}

type VisibleRequesterPreferences = ReturnType<typeof resolveRequesterPreferences>;

/** Requester facts the host forwards to a visible spawn; public callers omit them. */
export type VisibleChildPlanOptions = {
  requesterThinkingLevel?: VisibleRequesterPreferences["thinkingLevel"];
  requesterThinkingExplicit?: boolean;
  requesterModel?: VisibleRequesterPreferences["model"];
  loadModelCatalog?: VisibleChildModelCatalogLoader;
};

/**
 * Resolves the visible child's model plan together with the thinking level it is
 * created with. Both answers read the same requester preferences and prepared
 * catalog, so they are resolved once here and forwarded by the caller.
 */
export async function resolveVisibleChildModelPlan(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  targetAgentId: string;
  requesterEntry: SessionEntry | undefined;
  modelOverride?: string;
  workspaceDir?: string;
  options?: VisibleChildPlanOptions;
}) {
  const { cfg, requesterAgentId, targetAgentId, requesterEntry, options } = params;
  // Saved preferences carry the explicit-selection fact alongside the level, so
  // resolve them once: separate lookups make it easy to forward one without the other.
  let cachedPreferences: VisibleRequesterPreferences | undefined;
  const saved = () =>
    (cachedPreferences ??= resolveRequesterPreferences({ cfg, requesterAgentId, requesterEntry }));
  const modelPlan = await resolveSubagentModelAndThinkingPlan({
    cfg,
    targetAgentId,
    requesterAgentConfig: resolveAgentConfig(cfg, requesterAgentId),
    targetAgentConfig: resolveAgentConfig(cfg, targetAgentId),
    modelOverride: params.modelOverride,
    workspaceDir: params.workspaceDir,
    callerThinkingRaw: options?.requesterThinkingLevel ?? saved().thinkingLevel,
    // An automatic parent tier must not become the child's explicit saved
    // preference: hidden spawning forwards this provenance bit, and an
    // unselected child keeps its own model default.
    callerThinkingExplicit:
      options?.requesterThinkingLevel !== undefined
        ? options.requesterThinkingExplicit
        : saved().thinkingExplicit,
    inheritedModel:
      targetAgentId === requesterAgentId ? (options?.requesterModel ?? saved().model) : undefined,
  });
  if (modelPlan.status === "error") {
    return modelPlan;
  }
  return {
    ...modelPlan,
    thinkingLevel: await resolveVisibleChildThinkingLevel({
      cfg,
      targetAgentId,
      resolvedModel: modelPlan.resolvedModel,
      level: modelPlan.initialSessionPatch.thinkingLevel,
      loadModelCatalog: options?.loadModelCatalog,
    }),
  };
}
