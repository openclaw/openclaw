import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
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
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import {
  acquireStateDatabaseCoordinator,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  STATE_WAL_COORDINATOR_WAIT_MS,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { openTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import {
  prepareStateDatabaseInitialization,
  type StateDatabaseInitialization,
} from "./openclaw-state-db-initialization.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
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
  ensureSchema: (database: DatabaseSync, initialization: StateDatabaseInitialization) => void;
  recordOpenFailure: (pathname: string, error: Error) => void;
  existingSchema?: boolean;
  initializationAgentPaths?: readonly string[];
}): OpenClawStateDatabase {
  const { busyTimeoutMs, lockFailureReporting } = params;
  const initialization = prepareStateDatabaseInitialization(
    params.pathname,
    params.env,
    params.initializationAgentPaths,
  );
  const runtimeDirectory = resolveStateLifecycleRuntimeDirectory();
  const original = params.existingSchema ? statSync(params.pathname) : undefined;
  if (original && !original.isFile()) {
    throw new Error(`Existing shared-state database must be a regular file: ${params.pathname}`);
  }
  const assertSameFile = () => {
    if (original) {
      const current = statSync(params.pathname);
      if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) {
        throw new Error(`Existing shared-state database generation changed: ${params.pathname}`);
      }
    }
  };
  if (!params.existingSchema) {
    ensureOpenClawStatePermissions(params.pathname, params.env);
  }
  const db = openTrackedStateDatabase(params.pathname, { existingOnly: params.existingSchema });
  let walMaintenance: SqliteWalMaintenance | undefined;
  try {
    enableNodeSqliteKyselyStatementCache(db);
    setSqliteBusyTimeout(db, busyTimeoutMs);
    if (params.existingSchema) {
      assertSameFile();
      params.ensureSchema(db, initialization);
      assertSameFile();
      return {
        db,
        path: params.pathname,
        walMaintenance: {
          checkpoint: () => false,
          close: () => true,
          reclaimFreePages: createSqliteWalReclamationResult,
        },
      };
    }
    const maintenance = runWithSqliteBusyTimeout(
      db,
      busyTimeoutMs,
      () => {
        assertSupportedStateSchemaVersion(db, params.pathname);
        assertStateDatabaseIntegrityBeforeMutation(db, params.pathname);
        configureSqlitePreSchemaPragmas(db, { busyTimeoutMs });
        walMaintenance = configureSqliteConnectionPragmas(db, {
          busyTimeoutMs,
          databaseLabel: "openclaw-state",
          databasePath: params.pathname,
          onCheckpointError: (error) =>
            stateDbLog.warn("Shared-state WAL maintenance failed", {
              error: formatErrorMessage(error),
              path: params.pathname,
              checkpoint: walMaintenance?.health,
            }),
          runMaintenance: (operation) =>
            runWithSqliteCoordinator(
              acquireStateDatabaseCoordinator({
                databasePath: params.pathname,
                runtimeDirectory,
                busyTimeoutMs: STATE_WAL_COORDINATOR_WAIT_MS,
              }),
              "shared-state WAL maintenance",
              operation,
            ),
          foreignKeys: true,
          synchronous: "NORMAL",
        });
        params.ensureSchema(db, initialization);
        return walMaintenance;
      },
      { lockFailureReporting },
    );
    ensureOpenClawStatePermissions(params.pathname, params.env);
    return { db, path: params.pathname, walMaintenance: maintenance };
  } catch (error) {
    // Acquisition owns the native handle until every setup and hardening step returns.
    const errors = openClawStateDatabaseCache.closeUnpublishedOpenClawStateDatabaseHandle({
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
