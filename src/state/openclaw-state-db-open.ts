import type { DatabaseSync } from "node:sqlite";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import {
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
  type SqliteLockFailureReporting,
} from "../infra/sqlite-busy-timeout.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
} from "../infra/sqlite-coordinator.js";
import {
  assertSqliteIntegrity,
  isTerminalSqliteIntegrityError,
} from "../infra/sqlite-integrity.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { hasDanglingSkillWorkshopCollectionReviewIndex } from "./openclaw-state-db-dangling-workshop-index.js";
import { openTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaMigrationVersion,
} from "./openclaw-state-db-schema-version.js";

const stateDbLog = createSubsystemLogger("state/db");

function assertStateDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  pathname: string,
): void {
  const contentVersion = readStateSchemaMigrationVersion(database);
  const hasApplicationSchema = database // sqlite-allow-raw -- Cold-open schema presence probe before Kysely exposure.
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  const migrationPending =
    (contentVersion === 0 && hasApplicationSchema) ||
    (contentVersion > 0 && contentVersion < OPENCLAW_STATE_SCHEMA_VERSION);
  if (migrationPending) {
    stateDbLog.info("state database schema migration pending; verifying integrity first", {
      fromVersion: contentVersion,
      path: pathname,
      toVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  }
  if (contentVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
    // Every physical open proves the full file before schema mutation or exposure.
    assertSqliteIntegrity(database, pathname);
  }
}

export function openUnpublishedStateDatabase(params: {
  pathname: string;
  env: NodeJS.ProcessEnv;
  busyTimeoutMs: number;
  lockFailureReporting: SqliteLockFailureReporting;
  ensureSchema: (database: DatabaseSync) => void;
  recordOpenFailure: (pathname: string, error: Error) => void;
}): OpenClawStateDatabase {
  const { busyTimeoutMs, lockFailureReporting } = params;
  ensureOpenClawStatePermissions(params.pathname, params.env);
  const db = openTrackedStateDatabase(params.pathname);
  let walMaintenance: SqliteWalMaintenance | undefined;
  try {
    enableNodeSqliteKyselyStatementCache(db);
    setSqliteBusyTimeout(db, busyTimeoutMs);
    const maintenance = runWithSqliteBusyTimeout(
      db,
      busyTimeoutMs,
      () => {
        if (hasDanglingSkillWorkshopCollectionReviewIndex(db)) {
          throw new OpenClawStateDatabaseSchemaMigrationRequiredError(
            "legacy-workshop-review-index",
            params.pathname,
          );
        }
        assertSupportedStateSchemaVersion(db, params.pathname);
        assertStateDatabaseIntegrityBeforeMutation(db, params.pathname);
        configureSqlitePreSchemaPragmas(db, { busyTimeoutMs });
        walMaintenance = configureSqliteConnectionPragmas(db, {
          busyTimeoutMs,
          databaseLabel: "openclaw-state",
          databasePath: params.pathname,
          runMaintenance: (operation) =>
            runWithSqliteCoordinator(
              acquireStateDatabaseCoordinator({ databasePath: params.pathname, busyTimeoutMs: 0 }),
              "shared-state WAL maintenance",
              operation,
            ),
          foreignKeys: true,
          synchronous: "NORMAL",
        });
        params.ensureSchema(db);
        return walMaintenance;
      },
      { lockFailureReporting },
    );
    ensureOpenClawStatePermissions(params.pathname, params.env);
    return { db, path: params.pathname, walMaintenance: maintenance };
  } catch (error) {
    // Acquisition owns the native handle until every setup and hardening step returns.
    const errors = openClawStateDatabaseCache.closeOpenClawStateDatabaseHandle({
      db,
      path: params.pathname,
      walMaintenance,
    });
    if (
      error instanceof Error &&
      (isSqliteSchemaVersionError(error) || isTerminalSqliteIntegrityError(error))
    ) {
      params.recordOpenFailure(params.pathname, error);
    }
    if (errors.length > 0) {
      throw createSqliteLifecycleAggregateError(
        [error, ...errors],
        `OpenClaw state database acquisition and cleanup failed for ${params.pathname}.`,
        error,
      );
    }
    throw error;
  }
}
