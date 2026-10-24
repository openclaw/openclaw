import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  listExistingAgentDatabaseTargets,
  resolveTargetSqliteOptions,
} from "../infra/session-sqlite-migration-readers.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";

function readLegacyProperty(json: string | null, key: string): unknown {
  if (json === null) {
    return undefined;
  }
  try {
    return asOptionalRecord(JSON.parse(json))?.[key];
  } catch {
    // Unrelated malformed widget data stays with its existing repair owner.
    return undefined;
  }
}

function listRetiredWidgets(database: EngineConnection) {
  const db = getNodeSqliteKysely<Pick<DB, "board_widgets">>(database);
  return executeSqliteQuerySync(
    database,
    db.selectFrom("board_widgets").select(["session_key", "name", "descriptor_json", "manifest"]),
  ).rows.filter(
    (row) =>
      readLegacyProperty(row.descriptor_json, "pluginKind") === "canvas:a2ui" ||
      readLegacyProperty(row.manifest, "registeredContentKind") === "a2ui",
  );
}

/** Candidate Doctor owns this retirement; ordinary board readers only consume canonical widgets. */
export async function retireDoctorA2uiWidgets(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  integrityCheck?: "quick" | "full";
}): Promise<MigrationMessages> {
  const result: MigrationMessages = {
    changes: [],
    warnings: [],
    warningDisposition: "recoverable",
  };
  const targets = listExistingAgentDatabaseTargets(params.cfg, params.env);
  const pending = targets.filter((target) => {
    try {
      const inspected = withOpenClawAgentDatabaseReadOnly(
        (database) => listRetiredWidgets(database.db).length,
        resolveTargetSqliteOptions(target, params.env),
      );
      return inspected.found && inspected.value > 0;
    } catch (error) {
      result.warnings.push(
        `Could not inspect retired A2UI widgets in agent ${target.agentId}: ${formatErrorMessage(error)}. Run openclaw doctor --fix after resolving the database warning.`,
      );
      return false;
    }
  });
  if (pending.length === 0) {
    return result;
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    throw new Error("A2UI widget retirement requires Doctor maintenance ownership.");
  }
  maintenance.assertAdmission();
  const backup = await backupDoctorMigrationDatabases({
    env: params.env,
    pendingDatabasePaths: pending.map((target) => target.sqlitePath),
    databasePaths: targets.map((target) => target.sqlitePath),
    check: params.integrityCheck,
    // A same-version Doctor backup can predate newly created widgets.
    repair: { key: `retire-a2ui-widgets:${randomUUID()}` },
  });
  result.changes.push(...backup.changes);
  result.warnings.push(...backup.warnings);
  maintenance.assertAdmission();
  let removed = 0;
  for (const target of pending) {
    const wasOpen = isOpenClawAgentDatabaseOpen(target.sqlitePath);
    try {
      removed += runOpenClawAgentWriteTransaction(
        (database) => {
          maintenance.assertAdmission();
          const rows = listRetiredWidgets(database.db);
          const db = getNodeSqliteKysely<Pick<DB, "board_widgets">>(database.db);
          for (const row of rows) {
            executeSqliteQuerySync(
              database.db,
              db
                .deleteFrom("board_widgets")
                .where("session_key", "=", row.session_key)
                .where("name", "=", row.name),
            );
          }
          return rows.length;
        },
        resolveTargetSqliteOptions(target, params.env),
        { operationLabel: "doctor.retire-a2ui-widgets" },
      );
    } finally {
      if (!wasOpen) {
        await closeOpenClawAgentDatabaseByPathAsync(target.sqlitePath);
      }
    }
    maintenance.assertAdmission();
  }
  if (removed > 0) {
    result.warnings.push(
      `Deleted ${removed} stored widget(s) after backup. A2UI widgets were retired and can be recreated as HTML widgets.`,
    );
  }
  return result;
}
