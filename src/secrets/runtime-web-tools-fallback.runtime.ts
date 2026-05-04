import { resolveRuntimeWebFetchProviders } from "../plugins/web-fetch-providers.runtime.js";
import { resolveRuntimeWebSearchProviders } from "../plugins/web-search-providers.runtime.js";

export const runtimeWebToolsFallbackProviders = {
  resolveRuntimeWebFetchProviders,
  resolveRuntimeWebSearchProviders,
};
