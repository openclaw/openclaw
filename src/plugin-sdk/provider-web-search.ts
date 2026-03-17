// Public web-search registration helpers for provider plugins.

export {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  setScopedCredentialValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-plugin-factory.js";
export { withTrustedWebToolsEndpoint } from "../agents/tools/web-guarded-fetch.js";
export {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  writeCache,
} from "../agents/tools/web-shared.js";
