// Provider onboarding config helpers exposed to plugin extensions.
export type { OpenClawConfig } from "../config/config.js";
export {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalog,
} from "../commands/onboard-auth.config-shared.js";
// applyProviderConfigWithModelCatalogPreset adds alias and primaryModelRef support
// on top of applyProviderConfigWithModelCatalog. Implemented as a thin wrapper.
export {
  applyProviderConfigWithModelCatalogPreset,
} from "../commands/onboard-auth.config-preset.js";
