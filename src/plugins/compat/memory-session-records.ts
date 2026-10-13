import type { PluginCompatRecord } from "./types.js";

export const MEMORY_SESSION_COMPAT_RECORDS = [
  {
    code: "memory-session-sync-inventory",
    status: "removed",
    owner: "sdk",
    introduced: "2026-08-09",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    replacement:
      "Await loadArchivedSessionsAsync and resolveMemorySessionTargetsAsync from memory-core-host-engine-sessions.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-inventory-readers",
    surfaces: ["loadArchivedSessions", "resolveMemorySessionTargets"],
    diagnostics: ["plugin compatibility registry and migration guide"],
    tests: [
      "src/plugin-sdk/memory-core-host-engine-sessions.test.ts",
      "src/plugins/compat/registry.test.ts",
      "extensions/memory-core/src/memory-forget.sources.test.ts",
    ],
    releaseNote:
      "Removes synchronous archive discovery and forget target selection first deprecated in stable v2026.10.1. The existing worker-backed readers retain their metadata results; stored data is unchanged.",
  },
  {
    code: "memory-session-sync-metadata",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-26",
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    removalGate: "after-stable-deprecation",
    replacement:
      "Await loadMemorySessionMetadataAsync and loadMemorySessionMetadataBatchAsync from memory-core-host-engine-sessions. Bundled ingestion uses the history worker; the synchronous metadata reader retains its signature until removal after stable deprecation and a compatibility period.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-inventory-readers",
    surfaces: ["loadMemorySessionMetadata"],
    diagnostics: [
      "TypeScript @deprecated annotations, migration documentation, and one shared DEP_PLUGIN_SDK warning per plugin and memory-session family on main-thread legacy use",
    ],
    tests: [
      "src/plugin-sdk/memory-core-host-engine-sessions.test.ts",
      "src/plugins/compat/registry.test.ts",
      "extensions/memory-core/src/session-ingestion.test.ts",
    ],
    releaseNote:
      "Memory metadata readers have awaited replacements backed by the history worker; bundled ingestion no longer reads SQLite on the Gateway thread.",
  },
] as const satisfies readonly PluginCompatRecord[];
