import type { PluginCompatRecord } from "./types.js";

export const CRON_STORE_PATH_COMPAT_RECORD = {
  code: "cron-store-sync-path",
  status: "deprecated",
  owner: "sdk",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removeAfter: "2026-12-31",
  replacement:
    "Await resolveCronStorePathAsync(storePath) from openclaw/plugin-sdk/cron-store-runtime. The synchronous resolveCronStorePath(storePath) retains its existing return value through 2026-12-31; removal ships in the first January 2027 stable release.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#cron-store-path-resolution",
  surfaces: ["openclaw/plugin-sdk/cron-store-runtime resolveCronStorePath"],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous cron path resolution"],
} as const satisfies PluginCompatRecord;
