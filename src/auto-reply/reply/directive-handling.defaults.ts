import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  type ModelManifestNormalizationContext,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveDefaultModel(
  params: { cfg: OpenClawConfig; agentId?: string } & ModelManifestNormalizationContext,
): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const mainModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
  });
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });
  return { defaultProvider, defaultModel, aliasIndex };
}
