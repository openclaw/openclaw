import { statSync, type BigIntStats } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import {
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
  type SqliteLockFailureReporting,
} from "../infra/sqlite-busy-timeout.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  assertSqliteIntegrity,
  isTerminalSqliteIntegrityError,
} from "../infra/sqlite-integrity.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { withStateDatabaseSchemaMaintenance } from "../infra/state-database-maintenance.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
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
import { assertOpenClawStateWriteAllowed } from "./openclaw-state-ownership.js";

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

type UnpublishedStateDatabaseOptions = {
  pathname: string;
  env: NodeJS.ProcessEnv;
  busyTimeoutMs: number;
  lockFailureReporting: SqliteLockFailureReporting;
  ensureSchema: (database: DatabaseSync, initialization: StateDatabaseInitialization) => void;
  recordOpenFailure: (pathname: string, error: Error) => void;
  existingSchema?: boolean;
  initializationAgentPaths?: readonly string[];
};

export function openUnpublishedStateDatabase(
  params: UnpublishedStateDatabaseOptions,
): OpenClawStateDatabase {
  const open = (schemaOwned: boolean): OpenClawStateDatabase => {
    const original = params.existingSchema
      ? statSync(params.pathname, { bigint: true })
      : statSync(params.pathname, { bigint: true, throwIfNoEntry: false });
    if (!original && !schemaOwned) {
      return withStateDatabaseSchemaMaintenance(
        { databasePath: params.pathname, busyTimeoutMs: params.busyTimeoutMs },
        () => open(true),
      );
    }
    if (original && !original.isFile()) {
      throw new Error(`Existing shared-state database must be a regular file: ${params.pathname}`);
    }
    const initialization = prepareStateDatabaseInitialization(
      params.pathname,
      params.env,
      params.initializationAgentPaths,
    );
    if (!original) {
      quarantineOrphanedSqliteSidecars(params.pathname);
      ensureOpenClawStatePermissions(params.pathname, params.env, { createDirectory: true });
    }
    return openNativeStateDatabase(params, initialization, original);
  };
  return open(false);
}

function openNativeStateDatabase(
  params: UnpublishedStateDatabaseOptions,
  initialization: StateDatabaseInitialization,
  original: BigIntStats | undefined,
): OpenClawStateDatabase {
  const { busyTimeoutMs, lockFailureReporting } = params;
  const assertSameFile = () => {
    if (original) {
      const current = statSync(params.pathname, { bigint: true });
      if (
        !current.isFile() ||
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        current.birthtimeNs !== original.birthtimeNs
      ) {
        throw new Error(`Existing shared-state database generation changed: ${params.pathname}`);
      }
    }
  };
  // Observing an existing generation never authorizes recreating it after a reset.
  const db = openTrackedStateDatabase(params.pathname, {
    existingOnly: original !== undefined,
    expectedIdentity: original ? `file:${original.dev}:${original.ino}` : undefined,
  });
  let walMaintenance: SqliteWalMaintenance | undefined;
  try {
    assertSameFile();
    enableNodeSqliteKyselyStatementCache(db);
    setSqliteBusyTimeout(db, busyTimeoutMs);
    assertOpenClawStateWriteAllowed({
      database: db,
      databasePath: params.pathname,
      env: params.env,
    });
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
    ensureOpenClawStatePermissions(params.pathname, params.env);
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
          runMaintenance: (operation) => {
            assertStateDatabaseAccessAllowed(params.pathname);
            return operation();
          },
          foreignKeys: true,
          synchronous: "NORMAL",
        });
        params.ensureSchema(db, initialization);
        return walMaintenance;
      },
      { lockFailureReporting },
    );
    ensureOpenClawStatePermissions(params.pathname, params.env);
    assertSameFile();
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
