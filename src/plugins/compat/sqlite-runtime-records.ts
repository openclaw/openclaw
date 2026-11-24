import type { PluginCompatRecord } from "./types.js";

export const SQLITE_RUNTIME_COMPAT_RECORDS = [
  {
    code: "sqlite-runtime-native-access",
    status: "deprecated",
    owner: "sdk",
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
  },
] as const satisfies readonly PluginCompatRecord[];
