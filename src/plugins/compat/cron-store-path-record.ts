import type { PluginCompatRecord } from "./types.js";

export const CRON_STORE_PATH_COMPAT_RECORD = {
  code: "cron-store-sync-path",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-11",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await resolveCronStorePathAsync(storePath) from openclaw/plugin-sdk/cron-store-runtime. The synchronous resolveCronStorePath(storePath) retains its existing return value until the next Plugin SDK major and explicit breaking-release approval.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#cron-store-path-resolution",
  surfaces: ["openclaw/plugin-sdk/cron-store-runtime resolveCronStorePath"],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous cron path resolution"],
  tests: ["src/plugin-sdk/cron-store-compat.test.ts", "src/cron/store/config-state.test.ts"],
  releaseNote:
    "Runtime cron path selection uses the shared-state worker. Plugins can await resolveCronStorePathAsync; synchronous path resolution remains supported with a deprecation warning. Stored cron data and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
