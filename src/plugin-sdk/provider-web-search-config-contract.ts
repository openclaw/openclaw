// Public contract-safe web-search config helpers for provider plugins that do
// not need plugin enable/selection wiring.

import type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
export {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
export { createWebSearchProviderContractFields } from "./provider-web-search-contract.js";
export type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
};
