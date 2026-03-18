// Public web-search registration helpers for provider plugins.

import type { WebSearchProviderPlugin } from "../plugins/types.js";
export {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  setScopedCredentialValue,
  setTopLevelCredentialValue,
  withForcedProvider,
} from "../agents/tools/web-search-provider-config.js";
export { resolveWebSearchProviderCredential } from "../agents/tools/web-search-provider-credentials.js";
export { withTrustedWebToolsEndpoint } from "../agents/tools/web-guarded-fetch.js";
export {
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "../agents/tools/web-shared.js";
export { wrapWebContent } from "../security/external-content.js";

export type { WebSearchProviderPlugin };
