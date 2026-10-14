import type { PluginCompatRecord } from "./types.js";

export const SQLITE_RUNTIME_COMPAT_RECORDS = [
  {
    code: "sqlite-runtime-native-access",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-09",
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    removeAfter: "2026-12-31",
    replacement:
      "Use openOpenClawAgentSqliteWorkerStoreV2 with required live authority and serializable domain commands. Worker backends use sqlite-worker-runtime primitives; explicit readOnly inspection and offline Doctor maintenance retain their native contracts. Native callbacks are not serialized or moved by adding await. Released calls retain their signatures and synchronous transaction ordering through the deprecation period and are removed in the first January 2027 stable release after the final compatibility day, 2026-12-31.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#replace-native-sqlite-runtime-writes",
    surfaces: [
      "openclaw/plugin-sdk/sqlite-runtime.openNodeSqliteDatabase writable handles",
      "openclaw/plugin-sdk/sqlite-runtime.openOpenClawAgentSqliteWorkerStore publicationSource.DatabaseSync",
      "openclaw/plugin-sdk/sqlite-runtime.openOpenClawAgentDatabase",
      "openclaw/plugin-sdk/sqlite-runtime.borrowOpenClawAgentDatabase",
      "openclaw/plugin-sdk/sqlite-runtime.withOpenClawAgentDatabaseAsync",
      "openclaw/plugin-sdk/sqlite-runtime.withOpenClawAgentDatabaseWrite",
      "openclaw/plugin-sdk/sqlite-runtime.runOpenClawAgentWriteAdmission",
      "openclaw/plugin-sdk/sqlite-runtime.runSqliteImmediateTransaction",
      "openclaw/plugin-sdk/sqlite-runtime.runSqliteImmediateTransactionSync",
      "openclaw/plugin-sdk/sqlite-runtime.executeSqliteQuerySync",
      "openclaw/plugin-sdk/sqlite-runtime.executeSqliteQueryTakeFirstSync",
      "openclaw/plugin-sdk/sqlite-runtime.iterateSqliteQuerySync",
      "openclaw/plugin-sdk/sqlite-runtime.prepareSqliteQuerySync",
      "openclaw/plugin-sdk/sqlite-runtime.getNodeSqliteKysely",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and one shared warning per plugin identity and capability family on actual legacy use; unscoped consumers share a bounded SDK warning",
    ],
    tests: [
      "src/plugin-sdk/sqlite-runtime.legacy-compat.test.ts",
      "src/plugin-sdk/sqlite-runtime.preparation-compat.test.ts",
      "src/state/openclaw-agent-worker-store.test.ts",
    ],
    releaseNote:
      "Agent SQLite plugins can prepare and write through the canonical worker without borrowing a writable host handle. Memory Core uses worker commands for vector, metadata, origin, standing-intent and forget mutations. Raw SDK compatibility remains available through the deprecation period and is removed in the first January 2027 stable release after the final compatibility day, 2026-12-31; schemas, stored data and update behavior are unchanged.",
  },
] as const satisfies readonly PluginCompatRecord[];
