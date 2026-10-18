import type { PluginCompatRecord } from "./types.js";

export const TRANSCRIPT_STATS_COMPAT_RECORD = {
  code: "session-transcript-sync-statistics",
  status: "deprecated",
  owner: "sdk",
  removalGate: "stable-deprecation-period",
  introduced: "2026-07-11",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  replacement:
    "Await readTranscriptStatsAsync from session-store-runtime, or readTranscriptStatsBatchReadOnlyAsync and statSessionEntry from memory-core-host-engine-sessions. Batch reads preserve input order, duplicate IDs, and null results for unavailable stores through the existing history worker. Worker-local kernels and supplied statistics may retain direct synchronous reads; legacy main-thread SDK calls remain compatible until an announced later stable release.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-transcript-statistics",
  surfaces: [
    "openclaw/plugin-sdk/session-store-runtime.readTranscriptStatsSync",
    "openclaw/plugin-sdk/memory-core-host-engine-sessions.readTranscriptStatsBatchReadOnlySync",
    "openclaw/plugin-sdk/memory-core-host-engine-sessions.statSessionEntrySync",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations and one shared DEP_PLUGIN_SDK warning per plugin and session-store family on main-thread legacy use; worker-local reads do not warn",
  ],
  tests: [
    "src/plugin-sdk/session-store-runtime.stats.test.ts",
    "src/plugins/compat/registry.test.ts",
    "packages/memory-host-sdk/src/host/session-files.test.ts",
  ],
  releaseNote:
    "Plugins can await single or batched transcript statistics without running durable SQLite on the Gateway thread. Existing synchronous signatures remain available until an announced later stable release. Stored data, retention, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
