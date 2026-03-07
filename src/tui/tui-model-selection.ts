import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { buildModelAliasIndex, resolveConfiguredModelRef } from "../agents/model-selection.js";
import {
  createModelSelectionState,
  resolveModelDirectiveSelection,
  type ModelDirectiveSelection,
} from "../auto-reply/reply/model-selection.js";
import { loadConfig } from "../config/config.js";

export type TuiModelSelectionResult = {
  selection?: ModelDirectiveSelection;
  error?: string;
};

export async function resolveTuiModelSelection(params: {
  raw: string;
  currentProvider?: string;
  currentModel?: string;
}): Promise<TuiModelSelectionResult> {
  const cfg = loadConfig();
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: resolvedDefault.provider,
  });
  const currentProvider = params.currentProvider?.trim() || resolvedDefault.provider;
  const currentModel = params.currentModel?.trim() || resolvedDefault.model;
  const state = await createModelSelectionState({
    cfg,
    agentCfg: cfg.agents?.defaults,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    provider: currentProvider,
    model: currentModel,
    hasModelDirective: true,
  });

  return resolveModelDirectiveSelection({
    raw: params.raw,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    aliasIndex,
    allowedModelKeys: state.allowedModelKeys,
  });
}
