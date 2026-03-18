// Public web-search registration helpers for provider plugins.

import type { WebSearchProviderPlugin } from "../plugins/types.js";
export {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  setScopedCredentialValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
export { withTrustedWebToolsEndpoint } from "../agents/tools/web-guarded-fetch.js";
export {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  writeCache,
} from "../agents/tools/web-shared.js";

/**
 * @deprecated Implement provider-owned `createTool(...)` directly on the
 * returned WebSearchProviderPlugin instead of routing through core.
 */
export function createPluginBackedWebSearchProvider(
  provider: WebSearchProviderPlugin,
): WebSearchProviderPlugin {
  return {
    ...provider,
    createTool: () => {
      throw new Error(
        `createPluginBackedWebSearchProvider(${provider.id}) is no longer supported. ` +
          "Define provider-owned createTool(...) directly in the extension's WebSearchProviderPlugin.",
      );
    },
  };
}
