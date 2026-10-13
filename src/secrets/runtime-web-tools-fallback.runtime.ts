/** Lazy fallback provider discovery for web-tool secret metadata. */
import { resolvePluginWebFetchProvidersAsync } from "../plugins/web-fetch-providers.runtime.js";
import { resolvePluginWebSearchProvidersAsync } from "../plugins/web-search-providers.runtime.js";

/** Lazy-loaded provider discovery fallback used when public artifacts cannot prove the surface. */
export const runtimeWebToolsFallbackProviders = {
  resolvePluginWebFetchProvidersAsync,
  resolvePluginWebSearchProvidersAsync,
};
