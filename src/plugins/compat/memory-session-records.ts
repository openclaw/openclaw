import type { PluginCompatRecord } from "./types.js";

export const MEMORY_SESSION_COMPAT_RECORDS = [
  {
    code: "memory-session-sync-inventory",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-09",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await loadArchivedSessionsAsync and resolveMemorySessionTargetsAsync from memory-core-host-engine-sessions. Synchronous readers retain their existing signatures and results until the next Plugin SDK major.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-inventory-readers",
    surfaces: ["loadArchivedSessions", "resolveMemorySessionTargets"],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/memory-core-host-engine-sessions.test.ts",
      "src/plugins/compat/registry.test.ts",
      "extensions/memory-core/src/memory-forget.sources.test.ts",
    ],
    releaseNote:
      "Memory archive discovery and forget target selection can be awaited through worker-backed SDK readers; synchronous readers remain compatible until the next Plugin SDK major.",
  },
  {
    code: "memory-session-sync-metadata",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-26",
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await loadMemorySessionMetadataAsync and loadMemorySessionMetadataBatchAsync from memory-core-host-engine-sessions. Bundled ingestion uses the history worker; synchronous metadata readers retain their signatures until the next Plugin SDK major.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-inventory-readers",
    surfaces: ["loadMemorySessionMetadata", "loadMemorySessionMetadataBatch"],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
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
