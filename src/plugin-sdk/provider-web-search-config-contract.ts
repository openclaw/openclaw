// Public contract-safe web-search config helpers for provider plugins that do
// not need plugin enable/selection wiring.

export type {
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
export {
  getScopedCredentialValue,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
} from "../agents/tools/web-search-provider-config.js";
export { createBaseWebSearchProviderContractFields as createWebSearchProviderContractFields } from "./provider-web-search-contract-fields.js";
