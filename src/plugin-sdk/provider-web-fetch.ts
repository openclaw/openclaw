export type { WebFetchProviderToolDefinition } from "../plugins/types.js";
export {
  withSelfHostedWebToolsEndpoint,
  withStrictWebToolsEndpoint,
} from "../agents/tools/web-guarded-fetch.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { withTrustedWebToolsEndpoint } from "../agents/tools/web-guarded-fetch.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { jsonResult } from "../agents/tools/common.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { enablePluginInConfig } from "../plugins/enable.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { wrapExternalContent } from "../security/external-content.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { wrapWebContent } from "../security/external-content.js";
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
