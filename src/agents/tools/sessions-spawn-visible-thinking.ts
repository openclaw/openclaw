import type { ThinkLevel, ThinkingCatalogEntry } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadGatewayModelCatalogSnapshot } from "../../gateway/server-model-catalog.js";
import { findModelCatalogEntry } from "../model-catalog-lookup.js";
import { selectModelCatalogRuntimeEntry } from "../model-catalog-view.js";
import type { ModelCatalogEntry } from "../model-catalog.js";
import { splitModelRef } from "../subagents/spawn/subagent-spawn-plan.js";
import {
  resolveCandidateThinkingLevel,
  resolveEffectiveAgentRuntime,
} from "../thinking-runtime.js";

/**
 * `sessions.create` validates thinking against the concrete runtime row it
 * selects from `routeVariants`, so the clamp needs the whole snapshot. Loaders
 * that still answer with a bare row list stay supported: those rows serve as
 * both the logical catalog and its own route variants.
 */
export type VisibleChildModelCatalogLoader = (params: {
  agentId: string;
  getConfig: () => OpenClawConfig;
}) => Promise<
  | ModelCatalogEntry[]
  | { entries: ModelCatalogEntry[]; routeVariants?: readonly ModelCatalogEntry[] }
  | undefined
>;

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
}): Promise<
  { entries: ModelCatalogEntry[]; routeVariants: readonly ModelCatalogEntry[] } | undefined
> {
  try {
    const loaded = await (params.loadModelCatalog ?? loadGatewayModelCatalogSnapshot)({
      agentId: params.agentId,
      getConfig: () => params.cfg,
    });
    if (Array.isArray(loaded)) {
      return { entries: loaded, routeVariants: loaded };
    }
    if (!Array.isArray(loaded?.entries)) {
      return undefined;
    }
    return {
      entries: loaded.entries,
      routeVariants: Array.isArray(loaded.routeVariants) ? loaded.routeVariants : loaded.entries,
    };
  } catch {
    return undefined;
  }
}

/**
 * Mirrors Gateway's capability owner selection (`projectSessionsPatchEntry`):
 * the logical row identifies the model, then the concrete row for the runtime
 * that will own the child's turn supplies the thinking capabilities. Grading
 * against the logical row instead keeps levels the validator rejects (creation
 * fails where an omitted level used to succeed) and drops levels the selected
 * runtime does support.
 */
function selectVisibleChildThinkingCatalog(params: {
  catalog: { entries: ModelCatalogEntry[]; routeVariants: readonly ModelCatalogEntry[] };
  provider: string;
  modelId: string;
  agentRuntime: string;
}): ThinkingCatalogEntry[] {
  const logical = findModelCatalogEntry(params.catalog.entries, {
    provider: params.provider,
    modelId: params.modelId,
  });
  if (!logical) {
    return params.catalog.entries;
  }
  const selected = selectModelCatalogRuntimeEntry({
    entry: logical,
    routeVariants: params.catalog.routeVariants,
    runtimeId: params.agentRuntime,
  }).entry;
  return [selected];
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
export async function resolveVisibleChildThinkingLevel(params: {
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
  return resolveCandidateThinkingLevel({
    cfg,
    provider,
    modelId: model,
    level,
    catalog: selectVisibleChildThinkingCatalog({
      catalog: thinkingCatalog,
      provider,
      modelId: model,
      agentRuntime,
    }),
    agentId: targetAgentId,
    sessionKey: pendingSessionKey,
    agentRuntime,
  });
}
