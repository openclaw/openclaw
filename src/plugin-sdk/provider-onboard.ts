// Public config patch helpers for provider onboarding flows.

export type { OpenClawConfig } from "../config/config.js";
export type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.models.js";
export {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalog,
} from "../plugins/provider-onboarding-config.js";
export { ensureModelAllowlistEntry } from "../commands/model-allowlist.js";
