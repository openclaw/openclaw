// Thin wrapper over applyProviderConfigWithModelCatalog that also supports
// model aliases and an optional primary model ref.
import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ModelApi, ModelDefinitionConfig } from "../config/types.models.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
} from "./onboard-auth.config-shared.js";

export type ProviderConfigWithModelCatalogPresetParams = {
  agentModels?: Record<string, AgentModelEntryConfig>;
  providerId: string;
  api: ModelApi;
  baseUrl: string;
  catalogModels: ModelDefinitionConfig[];
  /** Optional model-ref → alias mappings to apply to agentModels entries. */
  aliases?: ReadonlyArray<{ modelRef: string; alias: string }>;
  /** If set, also updates the agent default primary model. */
  primaryModelRef?: string;
};

export function applyProviderConfigWithModelCatalogPreset(
  cfg: OpenClawConfig,
  params: ProviderConfigWithModelCatalogPresetParams,
): OpenClawConfig {
  // Build agentModels with aliases applied.
  const baseAgentModels = params.agentModels ?? {};
  const agentModels: Record<string, AgentModelEntryConfig> = { ...baseAgentModels };
  for (const { modelRef, alias } of params.aliases ?? []) {
    agentModels[modelRef] = { ...agentModels[modelRef], alias };
  }

  let result = applyProviderConfigWithModelCatalog(cfg, {
    agentModels,
    providerId: params.providerId,
    api: params.api,
    baseUrl: params.baseUrl,
    catalogModels: params.catalogModels,
  });

  if (params.primaryModelRef) {
    result = applyAgentDefaultModelPrimary(result, params.primaryModelRef);
  }

  return result;
}
