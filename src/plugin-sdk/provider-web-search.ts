// Public web-search registration helpers for provider plugins.

export type {
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
  WebSearchProviderToolExecutionContext,
} from "../plugins/types.js";
export { readProviderEnvValue } from "../secrets/provider-credential-values.js";
export {
  jsonResult,
  readNonNegativeIntegerParam,
  readNumberParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam as readStringParam,
} from "../agents/tools/common.js";
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
  parseIsoDateRange,
  parseWebSearchTimeFilters,
  readCachedSearchPayload,
  readConfiguredSecretString,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  postTrustedWebToolsJson,
  throwWebSearchApiError,
  withSelfHostedWebSearchEndpoint,
  withTrustedWebSearchEndpoint,
  writeCachedSearchPayload,
} from "../agents/tools/web-search-provider-common.js";
export {
  getScopedCredentialValue,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
} from "../agents/tools/web-search-provider-config.js";
export type { SearchConfigRecord } from "../agents/tools/web-search-provider-common.js";
export { resolveWebSearchProviderCredential } from "../agents/tools/web-search-provider-credentials.js";
export {
  withSelfHostedWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
} from "../agents/tools/web-guarded-fetch.js";
export { truncateWebFetchText as truncateText } from "../agents/tools/web-fetch-utils.js";
export {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolvePositiveTimeoutSeconds,
  resolveTimeoutSeconds,
  writeCache,
} from "../agents/tools/web-shared.js";
export { enablePluginInConfig } from "../plugins/enable.js";
export { formatCliCommand } from "../cli/command-format.js";
export { wrapWebContent } from "../security/external-content.js";
