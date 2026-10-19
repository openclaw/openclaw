import type { PluginCompatRecord } from "./types.js";

export const MEMORY_SESSION_COMPAT_RECORDS = [
  {
    code: "memory-manager-sync-status",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-01-27",
    deprecated: "2026-10-13",
    warningStarts: "2026-10-16",
    removeAfter: "2026-12-31",
    replacement:
      "Implement and await MemorySearchManager.statusAsync. Consumers of legacy manager types can await readMemorySearchManagerStatus, which retains the synchronous fallback through 2026-12-31. Remove the status member and fallback in the first January 2027 stable release.",
    docsPath: "/plugins/sdk-migration/sqlite-async",
    surfaces: ["MemorySearchManager.status", "MemoryIndexManager.status"],
    diagnostics: [
      "TypeScript @deprecated annotations and a runtime warning once per plugin and method from the built-in MemoryIndexManager",
    ],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "extensions/memory-core/src/memory/manager-worker-reads.test.ts",
    ],
    releaseNote:
      "The built-in memory manager warns synchronous status callers to await statusAsync; the legacy interface and third-party fallback remain compatible through 2026-12-31.",
  },
  {
    code: "memory-session-sync-inventory",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-09",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    removeAfter: "2026-12-31",
    replacement:
      "Await loadArchivedSessionsAsync and resolveMemorySessionTargetsAsync from memory-core-host-engine-sessions. Synchronous readers retain their existing signatures and results through 2026-12-31.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-inventory-readers",
    surfaces: [
      "openclaw/plugin-sdk/memory-core-host-engine-sessions.loadArchivedSessions",
      "openclaw/plugin-sdk/memory-core-host-engine-sessions.resolveMemorySessionTargets",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations, migration documentation, and a runtime warning once per plugin and family",
    ],
    tests: [
      "src/plugin-sdk/memory-core-host-engine-sessions.test.ts",
      "src/plugins/compat/registry.test.ts",
      "extensions/memory-core/src/memory-forget.sources.test.ts",
    ],
    releaseNote:
      "Memory archive discovery and forget target selection can be awaited through worker-backed SDK readers; synchronous readers remain compatible through 2026-12-31.",
  },
  {
    code: "memory-session-sync-metadata",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-26",
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    removeAfter: "2026-12-31",
    replacement:
      "Await loadMemorySessionMetadataAsync and loadMemorySessionMetadataBatchAsync from memory-core-host-engine-sessions. Bundled ingestion uses the history worker; the synchronous metadata reader retains its signature through 2026-12-31.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-inventory-readers",
    surfaces: ["openclaw/plugin-sdk/memory-core-host-engine-sessions.loadMemorySessionMetadata"],
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
