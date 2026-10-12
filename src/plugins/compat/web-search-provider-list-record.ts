import type { PluginCompatRecord } from "./types.js";

export const WEB_SEARCH_PROVIDER_LIST_COMPAT_RECORD = {
  code: "web-search-sync-provider-list",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-11",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await runtime.webSearch.listProvidersAsync(params). The synchronous listProviders(params) retains its return shape until the next Plugin SDK major and explicit breaking-release approval.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#web-search-provider-lists",
  surfaces: ["PluginRuntime.webSearch.listProviders"],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous web-search provider lists"],
  tests: ["src/web-search/runtime-discovery.test.ts", "src/plugins/runtime/index.test.ts"],
  releaseNote:
    "Web-search provider lists have an asynchronous runtime API that prepares discovery policy through the shared-state worker. The synchronous plugin API remains supported with a deprecation warning.",
} as const satisfies PluginCompatRecord;
