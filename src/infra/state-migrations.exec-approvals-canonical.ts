import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sanitizeOpenClawStateLeaseRows } from "../state/openclaw-state-snapshot-sanitizer.js";
import { parseLegacyExecApprovals, parsePersistedExecApprovals } from "./exec-approvals-config.js";
import { writeExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import type { MigrationMessages } from "./state-migrations.types.js";

function readRow(db: DatabaseSync) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<DB, "exec_approvals_config">>(db)
      .selectFrom("exec_approvals_config")
      .selectAll()
      .where("config_key", "=", "current"),
  );
}

function readCanonicalRow(env: NodeJS.ProcessEnv) {
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => (tableExists(db, "exec_approvals_config") ? readRow(db) : undefined),
    { env },
  );
}

export function hasLegacySqliteExecApprovals(env: NodeJS.ProcessEnv): boolean {
  const row = readCanonicalRow(env);
  return Boolean(
    row &&
    !parsePersistedExecApprovals(row.raw_json).ok &&
    parseLegacyExecApprovals(row.raw_json).ok,
  );
}

/** The existing exec-policy Doctor owner holds exclusive maintenance for the entire repair. */
export async function repairLegacySqliteExecApprovals(
  env: NodeJS.ProcessEnv,
): Promise<MigrationMessages> {
  const sourcePath = resolveOpenClawStateSqlitePath(env);
  const identity = readDatabasePathIdentitySync(sourcePath);
  const row = readCanonicalRow(env);
  if (!row || parsePersistedExecApprovals(row.raw_json).ok) {
    return { changes: [], warnings: [] };
  }
  const parsed = parseLegacyExecApprovals(row.raw_json);
  if (!parsed.ok) {
    return { changes: [], warnings: [] };
  }
  const authority = getOpenClawDatabaseMaintenanceScope();
  if (!authority?.ownsSchemaMaintenance) {
    throw new Error("Exec approval policy repair requires Doctor maintenance ownership.");
  }
  const assertCurrent = () => {
    authority.assertAdmission();
    if (!isDeepStrictEqual(readDatabasePathIdentitySync(sourcePath), identity)) {
      throw new Error("Exec approval database changed during Doctor repair; source retained.");
    }
  };
  assertCurrent();
  const backup = await createVerifiedSqliteSnapshot({
    sourcePath,
    targetPath: `${sourcePath}.pre-exec-approvals-migration-${randomUUID()}.bak`,
    preserveRowIds: true,
    transform: sanitizeOpenClawStateLeaseRows,
    validate: (snapshot) => {
      if (!isDeepStrictEqual(readRow(snapshot), row)) {
        throw new Error("Exec approval backup does not match the planned policy; source retained.");
      }
    },
    beforePublish: assertCurrent,
  });
  assertCurrent();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      const current = readRow(db);
      if (!isDeepStrictEqual(current, row)) {
        throw new Error("Exec approval policy changed during Doctor repair; source retained.");
      }
      writeExecApprovalsConfigRow({ db, file: parsed.value, now: row.updated_at_ms });
    },
    { env },
  );
  return {
    changes: ["Normalized legacy SQLite exec approvals before runtime access."],
    warnings: [],
    notices: [`Preserved original exec approval policy in ${backup.path}.`],
  };
}
