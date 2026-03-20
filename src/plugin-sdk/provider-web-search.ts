// Public web-search registration helpers for provider plugins.

import type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
export { readNumberParam, readStringArrayParam, readStringParam } from "../agents/tools/common.js";
export { resolveCitationRedirectUrl } from "../agents/tools/web-search-citation-redirect.js";
export {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  FRESHNESS_TO_RECENCY,
  isoToPerplexityDate,
  MAX_SEARCH_COUNT,
  normalizeFreshness,
  normalizeToIsoDate,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  throwWebSearchApiError,
  withTrustedWebSearchEndpoint,
  writeCachedSearchPayload,
} from "../agents/tools/web-search-provider-common.js";
export {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
export type { SearchConfigRecord } from "../agents/tools/web-search-provider-common.js";
export { resolveWebSearchProviderCredential } from "../agents/tools/web-search-provider-credentials.js";
export { withTrustedWebToolsEndpoint } from "../agents/tools/web-guarded-fetch.js";
export {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "../agents/tools/web-shared.js";
export { enablePluginInConfig } from "../plugins/enable.js";
export { formatCliCommand } from "../cli/command-format.js";
export { wrapWebContent } from "../security/external-content.js";
export type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
};

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
