import { resolvePluginWebFetchProviders } from "../plugins/web-fetch-providers.runtime.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";

export const runtimeWebToolsFallbackProviders = {
  resolvePluginWebFetchProviders,
  resolvePluginWebSearchProviders,
};
