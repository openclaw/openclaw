// Narrow shared exports for web-search contract surfaces.

import type { WebSearchProviderPlugin } from "../plugins/types.js";

export {
  getScopedCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
} from "../agents/tools/web-search-provider-config.js";
export { enablePluginInConfig } from "../plugins/enable.js";
export type { WebSearchProviderPlugin };
