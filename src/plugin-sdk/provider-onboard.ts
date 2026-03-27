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
  createDefaultModelPresetAppliers,
  createDefaultModelsPresetAppliers,
  createModelCatalogPresetAppliers,
  applyProviderConfigWithDefaultModelPreset,
  applyProviderConfigWithDefaultModelsPreset,
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalogPreset,
  applyProviderConfigWithModelCatalog,
  withAgentModelAliases,
} from "../plugins/provider-onboarding-config.js";
export type {
  AgentModelAliasEntry,
  ProviderOnboardPresetAppliers,
} from "../plugins/provider-onboarding-config.js";
export { ensureModelAllowlistEntry } from "../plugins/provider-model-allowlist.js";
export {
  applyCloudflareAiGatewayConfig,
  applyCloudflareAiGatewayProviderConfig,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
} from "../../extensions/cloudflare-ai-gateway/onboard.js";
export {
  applyVercelAiGatewayConfig,
  applyVercelAiGatewayProviderConfig,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
} from "../../extensions/vercel-ai-gateway/onboard.js";
