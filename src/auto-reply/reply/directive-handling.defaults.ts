import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
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
  /** Undefined when the agent has no configured model. */
  defaultModel: string | undefined;
  aliasIndex: ModelAliasIndex;
} {
  const manifestPlugins = getCurrentPluginMetadataSnapshot({
    config: params.cfg,
    allowWorkspaceScopedSnapshot: true,
  });
  const modelContext = { cfg: params.cfg, agentId: params.agentId, manifestPlugins };
  const configured = resolveDefaultModelForAgent(modelContext);
  const defaultProvider = configured?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = configured?.model;
  const aliasIndex = buildModelAliasIndex({ ...modelContext, defaultProvider });
  return { defaultProvider, defaultModel, aliasIndex };
}
