// Public contract-safe web-search registration helpers for provider plugins.

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
export { enablePluginInConfig } from "../plugins/enable.js";
export type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
};
