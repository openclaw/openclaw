import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabaseForDoctor,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sanitizeOpenClawStateLeaseRows } from "../state/openclaw-state-snapshot-sanitizer.js";
import { openClientCredentialCustodyAsync } from "./client-credential-store.js";
import { parseLegacyExecApprovals, parsePersistedExecApprovals } from "./exec-approvals-config.js";
import { writeExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "./sql-connection.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import { runUpdateSqliteMigrationAsync } from "./update-doctor-migration-attribution.js";

function readRow(db: EngineConnection) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<DB, "exec_approvals_config">>(db)
      .selectFrom("exec_approvals_config")
      .selectAll()
      .where("config_key", "=", "current"),
  );
}

function readCanonicalRow(db: EngineConnection) {
  return tableExists(db, "exec_approvals_config") ? readRow(db) : undefined;
}

export function hasLegacySqliteExecApprovals(env: NodeJS.ProcessEnv): boolean {
  const row = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => readCanonicalRow(db),
    { env },
  );
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
  const row = await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
    ({ db }) => readCanonicalRow(db),
    { env },
  );
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
  const source = await openOpenClawStateDatabaseForDoctor({ env });
  using credentials =
    parsed.value.socket?.path || parsed.value.socket?.token
      ? await openClientCredentialCustodyAsync(env, { createIfMissing: true })
      : undefined;
  const write = () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        assertCurrent();
        const current = readRow(db);
        if (!isDeepStrictEqual(current, row)) {
          throw new Error("Exec approval policy changed during Doctor repair; source retained.");
        }
        if (parsed.value.socket?.path || parsed.value.socket?.token) {
          if (!credentials) {
            throw new Error("Local client credential custody is unavailable.");
          }
          credentials.run({
            kind: "socket.ensure",
            fallback: {
              socket_key: "current",
              socket_path: parsed.value.socket.path ?? null,
              socket_token: parsed.value.socket.token ?? null,
              updated_at_ms: row.updated_at_ms,
            },
          });
        }
        writeExecApprovalsConfigRow({ db, file: parsed.value, now: row.updated_at_ms });
      },
      { env },
    );
  if (isPostgresSqlConnection(source.db)) {
    if (credentials) {
      await runUpdateSqliteMigrationAsync(credentials.database, credentials.path, write, {
        retainExclusive: true,
      });
    } else {
      write();
    }
  } else {
    await runUpdateSqliteMigrationAsync(source.db, source.path, write, {
      companions: credentials ? [credentials] : [],
    });
  }
  return {
    changes: ["Normalized legacy SQLite exec approvals before runtime access."],
    warnings: [],
    notices: [`Preserved original exec approval policy in ${backup.path}.`],
  };
}
