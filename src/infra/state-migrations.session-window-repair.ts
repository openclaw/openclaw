import type { DatabaseSync } from "node:sqlite";
import { deleteSessionTranscriptFtsRowsInTransaction } from "../config/sessions/session-transcript-fts.js";
import {
  CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db-contract.js";
import {
  assertAgentDatabaseMaintenanceAuthority,
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation,
} from "../state/openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import {
  assertOpenClawAgentSchemaContains,
  getOpenClawAgentMigrationSchema,
  readExistingAgentSchemaMeta,
} from "../state/openclaw-agent-db-schema-helpers.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { backupDoctorSqliteRepair } from "./sqlite-index-recovery.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { SqliteSchemaMismatchError } from "./sqlite-schema-issues.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import type { AgentDatabaseMigrationTarget } from "./state-migrations.media-persistence-targets.js";

/** Doctor alone may remove windows whose logical node no longer exists. */
export function repairDoctorSessionWindowOrphans(
  database: DatabaseSync,
  pathname: string,
  assertCurrent: () => void,
): string[] {
  assertCurrent();
  const schemaVersion = readSqliteUserVersion(database);
  if (
    schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION &&
    schemaVersion !== CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION - 1
  ) {
    return [];
  }
  if (readExistingAgentSchemaMeta(database)?.schemaVersion !== schemaVersion) {
    throw new SqliteSchemaMismatchError(
      `Agent schema markers disagree for ${pathname}; repair ownership metadata before orphan-window repair.`,
    );
  }
  // Preserve schema-24 repair before its schema-25 migration or backup.
  assertOpenClawAgentSchemaContains(
    database,
    pathname,
    getOpenClawAgentMigrationSchema(schemaVersion),
    "current",
    true,
  );
  database.exec("PRAGMA foreign_keys = ON;");
  return runSqliteImmediateTransactionSync(
    database,
    () => {
      assertCurrent();
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
      const windows = db
        .selectFrom("session_windows")
        .leftJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
        .where("session_nodes.session_key", "is", null)
        .select("session_windows.session_id");
      if (!executeSqliteQueryTakeFirstSync(database, windows)) {
        return [];
      }
      const backupPath = backupDoctorSqliteRepair(pathname, "session-window");
      assertCurrent();
      const foreignKeys = database.prepare("PRAGMA foreign_key_list(session_windows);");
      foreignKeys.setReadBigInts(true);
      const keys = foreignKeys.all();
      const nodeKey = keys.find(
        (key) =>
          key.table === "session_nodes" &&
          key.from === "session_key" &&
          key.to === "session_key" &&
          key.on_delete === "CASCADE",
      );
      const nodeKeyId =
        nodeKey && keys.filter((key) => key.id === nodeKey.id).length === 1
          ? nodeKey.id
          : undefined;
      const violations = database.prepare("PRAGMA foreign_key_check;");
      violations.setReadBigInts(true);
      // Deletion must not conceal an unrelated FK violation on the same orphan or its children.
      for (const violation of violations.iterate()) {
        if (
          violation.table !== "session_windows" ||
          violation.parent !== "session_nodes" ||
          violation.fkid !== nodeKeyId
        ) {
          assertSqliteIntegrity(database, pathname);
        }
      }
      invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname);
      assertCurrent();
      // FTS is virtual and has no FK cascade; its existing owner clears derived rows.
      for (const window of iterateSqliteQuerySync(database, windows)) {
        deleteSessionTranscriptFtsRowsInTransaction(database, window.session_id);
      }
      const deleted = executeSqliteQuerySync(
        database,
        db.deleteFrom("session_windows").where("session_id", "in", windows),
      );
      assertSqliteIntegrity(database, pathname);
      return [
        `Saved pre-repair SQLite backup: ${backupPath}`,
        `Removed ${deleted.numAffectedRows} orphan session window(s) from ${pathname}; their dependent history remains in the backup.`,
      ];
    },
    {
      databaseLabel: pathname,
      operationLabel: "session.orphan-window-repair",
      withCommit: (commit) => {
        assertCurrent();
        commit();
      },
    },
  );
}

/** Repair supported session-window shapes before the full migration backup admits their rows. */
export async function repairDoctorSessionWindowsBeforeMigration(params: {
  env: NodeJS.ProcessEnv;
  targets: readonly AgentDatabaseMigrationTarget[];
}): Promise<string[]> {
  return withAgentDatabaseMaintenanceLease(
    { env: params.env, schemaPolicy: "existing", processBound: true },
    async (maintenance) => {
      const changes: string[] = [];
      for (const target of params.targets) {
        assertAgentDatabaseMaintenanceAuthority(maintenance);
        const pathname = target.path;
        const database = openNodeSqliteDatabase(pathname);
        try {
          const assertCurrent = () => {
            assertAgentDatabaseMaintenanceAuthority(maintenance);
            assertOpenClawAgentDatabaseOwner(database, { agentId: target.agentId, pathname });
          };
          changes.push(...repairDoctorSessionWindowOrphans(database, pathname, assertCurrent));
        } finally {
          database.close();
        }
      }
      return changes;
    },
  );
}
