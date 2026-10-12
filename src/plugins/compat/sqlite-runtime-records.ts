import type { PluginCompatRecord } from "./types.js";

export const SQLITE_RUNTIME_COMPAT_RECORDS = [
  {
    code: "sqlite-runtime-native-access",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-09",
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Use openOpenClawAgentSqliteWorkerStoreV2 with required live authority and serializable domain commands. Worker backends use sqlite-worker-runtime primitives; explicit readOnly inspection and offline Doctor maintenance retain their native contracts. Native callbacks are not serialized or moved by adding await. Released calls retain their signatures and synchronous transaction ordering until the next Plugin SDK major.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#replace-native-sqlite-runtime-writes",
    surfaces: [
      "sqlite-runtime.openNodeSqliteDatabase writable handles",
      "sqlite-runtime.openOpenClawAgentSqliteWorkerStore publicationSource.DatabaseSync",
      "sqlite-runtime.openOpenClawAgentDatabase",
      "sqlite-runtime.borrowOpenClawAgentDatabase",
      "sqlite-runtime.withOpenClawAgentDatabaseAsync",
      "sqlite-runtime.withOpenClawAgentDatabaseRuntime",
      "sqlite-runtime.withOpenClawAgentDatabaseWrite",
      "sqlite-runtime.runOpenClawAgentWriteAdmission",
      "sqlite-runtime.runSqliteImmediateTransaction",
      "sqlite-runtime.runSqliteImmediateTransactionSync",
      "sqlite-runtime.executeSqliteQuerySync",
      "sqlite-runtime.executeSqliteQueryTakeFirstSync",
      "sqlite-runtime.iterateSqliteQuerySync",
      "sqlite-runtime.prepareSqliteQuerySync",
      "sqlite-runtime.getNodeSqliteKysely",
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
      "Agent SQLite plugins can prepare and write through the canonical worker without borrowing a writable host handle. Memory Core uses worker commands for vector, metadata, origin, standing-intent and forget mutations. Raw SDK compatibility remains available until the next Plugin SDK major; schemas, stored data and update behavior are unchanged.",
  },
] as const satisfies readonly PluginCompatRecord[];
