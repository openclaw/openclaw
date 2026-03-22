// Curated config-patch helpers for provider onboarding flows.

export type { OpenClawConfig } from "../config/config.js";
export type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.models.js";
export {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  applyProviderConfigWithDefaultModelPreset,
  applyProviderConfigWithDefaultModelsPreset,
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalogPreset,
  applyProviderConfigWithModelCatalog,
  withAgentModelAliases,
} from "../plugins/provider-onboarding-config.js";
export type { AgentModelAliasEntry } from "../plugins/provider-onboarding-config.js";
export { ensureModelAllowlistEntry } from "../plugins/provider-model-allowlist.js";
