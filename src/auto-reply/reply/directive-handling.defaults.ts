import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";

/** Resolve default provider/model plus alias index for directive parsing. */
export function resolveDefaultModel(params: { cfg: OpenClawConfig; agentId?: string }): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const manifestPlugins = getCurrentPluginMetadataSnapshot({
    config: params.cfg,
    allowWorkspaceScopedSnapshot: true,
  });
  const { provider: defaultProvider, model: defaultModel } = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
    agentId: params.agentId,
    manifestPlugins,
  });
  return { defaultProvider, defaultModel, aliasIndex };
}
