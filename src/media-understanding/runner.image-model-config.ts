import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";

/** Resolve authored image-model routes without changing their provider identities. */
export function resolveImageModelFromAgentDefaults(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): MediaUnderstandingModelConfig[] {
  const refs = [
    resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.imageModel),
    ...resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.imageModel),
  ]
    .map((ref) => ref?.trim())
    .filter((ref): ref is string => Boolean(ref));
  if (refs.length === 0) {
    return [];
  }
  const defaultProvider = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  }).provider;
  const entries: MediaUnderstandingModelConfig[] = [];
  for (const ref of refs) {
    const effectiveDefaultProvider = ref.includes("/")
      ? defaultProvider
      : (inferUniqueProviderFromConfiguredModels({
          cfg: params.cfg,
          model: ref,
          agentId: params.agentId,
        }) ?? defaultProvider);
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: effectiveDefaultProvider,
      agentId: params.agentId,
    });
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw: ref,
      defaultProvider: effectiveDefaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    entries.push({
      type: "provider",
      provider: resolved.ref.provider,
      model: resolved.ref.model,
    });
  }
  return entries;
}
