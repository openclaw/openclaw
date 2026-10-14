// Public web-fetch registration helpers for provider plugins.

export type { WebFetchProviderToolDefinition } from "../plugins/types.js";
export {
  withSelfHostedWebToolsEndpoint,
  withStrictWebToolsEndpoint,
} from "../agents/tools/web-guarded-fetch.js";
export {
  markdownToText,
  truncateWebFetchText as truncateText,
} from "../agents/tools/web-fetch-utils.js";
export {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolvePositiveTimeoutSeconds,
  writeCache,
} from "../agents/tools/web-shared.js";
