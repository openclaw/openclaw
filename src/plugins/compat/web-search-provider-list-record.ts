import type { PluginCompatRecord } from "./types.js";

export const WEB_SEARCH_PROVIDER_LIST_COMPAT_RECORD = {
  code: "web-search-sync-provider-list",
  status: "deprecated",
  owner: "sdk",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removeAfter: "2026-12-31",
  replacement:
    "Await runtime.webSearch.listProvidersAsync(params). The synchronous listProviders(params) retains its return shape through 2026-12-31; removal ships in the first January 2027 stable release.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#web-search-provider-lists",
  surfaces: ["PluginRuntime.webSearch.listProviders"],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous web-search provider lists"],
} as const satisfies PluginCompatRecord;
