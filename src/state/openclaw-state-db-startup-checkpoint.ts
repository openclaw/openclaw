import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { readSqliteSchemaCookie } from "../infra/sqlite-schema-contract.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { configureSqlitePreSchemaPragmas } from "../infra/sqlite-wal.js";
import { withStateDatabaseSchemaMaintenance } from "../infra/state-database-maintenance.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import {
  prepareStateDatabaseInitialization,
  type StateDatabaseInitialization,
} from "./openclaw-state-db-initialization.js";
import { resolveDatabasePath } from "./openclaw-state-db-maintenance.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { assertOpenClawStateSchemaRepairAllowed } from "./openclaw-state-db-schema-policy.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { assertOpenClawStateWriteAllowed } from "./openclaw-state-ownership.js";

// Native Swift stores may create only these canonical objects before Node owns schema bootstrap.
const NATIVE_STARTUP_BOOTSTRAP_OBJECTS = new Set([
  "table:device_auth_tokens",
  "index:idx_device_auth_tokens_updated",
  "table:device_identities",
  "index:idx_device_identities_device",
  "table:exec_approvals_config",
  "table:macos_port_guardian_records",
  "index:idx_macos_port_guardian_records_port",
  "table:schema_meta",
  "table:state_leases",
  "index:idx_state_leases_expiry",
  "index:idx_state_leases_owner",
]);

export function isUninitializedNativeStartupDatabase(db: DatabaseSync): boolean {
  if (readSqliteUserVersion(db) !== 0) {
    return false;
  }
  const objects = db // sqlite-allow-raw -- Pre-bootstrap schema ownership is checked before Kysely exposure.
    .prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
    .all();
  if (
    objects.some(
      ({ type, name }) =>
        typeof type !== "string" ||
        typeof name !== "string" ||
        !NATIVE_STARTUP_BOOTSTRAP_OBJECTS.has(`${type}:${name}`),
    )
  ) {
    return false;
  }
  const tableNames = new Set(
    objects.filter(({ type }) => type === "table").map(({ name }) => name),
  );
  if (
    tableNames.has("schema_meta") &&
    db // sqlite-allow-raw -- An existing metadata row means this is not an unowned fresh bootstrap.
      .prepare("SELECT 1 FROM schema_meta LIMIT 1")
      .get()
  ) {
    return false;
  }
  return !(
    tableNames.has("state_leases") &&
    db // sqlite-allow-raw -- Never initialize across another startup's existing migration lease.
      .prepare("SELECT 1 FROM state_leases LIMIT 1")
      .get()
  );
}

function ensureStartupMigrationCheckpointSchema(
  db: DatabaseSync,
  pathname: string,
  env: NodeJS.ProcessEnv,
): void {
  runSqliteImmediateTransactionSync(
    db,
    () => {
      assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
      assertSupportedStateSchemaVersion(db, pathname);
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT,
          app_version TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS state_leases (
          scope TEXT NOT NULL,
          lease_key TEXT NOT NULL,
          owner TEXT NOT NULL,
          expires_at INTEGER,
          heartbeat_at INTEGER,
          payload_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, lease_key)
        );
        CREATE INDEX IF NOT EXISTS idx_state_leases_expiry
          ON state_leases(expires_at, scope, lease_key)
          WHERE expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_state_leases_owner
          ON state_leases(owner, updated_at DESC);
      `);
      ensureColumn(db, "schema_meta", "app_version TEXT");
    },
    {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: pathname,
      operationLabel: "state.schema.ensure-startup-checkpoint",
    },
  );
}

function hasStartupMigrationCheckpointSchema(db: DatabaseSync): boolean {
  const objects = db // sqlite-allow-raw -- Checkpoint open admission distinguishes row access from additive schema repair.
    .prepare(`SELECT type, name FROM sqlite_schema WHERE name IN (
      'schema_meta', 'state_leases', 'idx_state_leases_expiry', 'idx_state_leases_owner'
    )`)
    .all();
  const has = (type: string, name: string) =>
    objects.some((row) => row.type === type && row.name === name);
  return (
    has("table", "schema_meta") &&
    has("table", "state_leases") &&
    has("index", "idx_state_leases_expiry") &&
    has("index", "idx_state_leases_owner") &&
    tableHasColumn(db, "schema_meta", "app_version")
  );
}

export function withOpenClawStateStartupCheckpointConnection<T>(
  callback: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions & { atomic?: boolean },
  initializeCanonicalSchema: (
    db: DatabaseSync,
    pathname: string,
    env: NodeJS.ProcessEnv,
    initialization: StateDatabaseInitialization,
  ) => void,
): T {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  assertOpenClawStateSchemaRepairAllowed(pathname);
  const open = (schemaOwned: boolean): T => {
    assertStateDatabaseAccessAllowed(pathname);
    const existing = existsSync(pathname);
    if (!existing && !schemaOwned) {
      return withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () => open(true));
    }
    const initialization = prepareStateDatabaseInitialization(
      pathname,
      env,
      options.initializationAgentPaths,
    );
    if (!existing) {
      quarantineOrphanedSqliteSidecars(pathname);
      ensureOpenClawStatePermissions(pathname, env, { createDirectory: true });
    }
    const db = openNodeSqliteDatabase(existing ? resolveExistingSqliteFileUri(pathname) : pathname);
    let ownershipAdmitted = false;
    let result: { value: T } | undefined;
    try {
      setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
      assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
      ownershipAdmitted = true;
      ensureOpenClawStatePermissions(pathname, env);
      if (schemaOwned) {
        configureSqlitePreSchemaPragmas(db, {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        });
      }
      const operate = () => {
        assertSqliteIntegrity(db, pathname);
        assertSupportedStateSchemaVersion(db, pathname);
        const initialize = isUninitializedNativeStartupDatabase(db);
        const needsSchema = initialize || !hasStartupMigrationCheckpointSchema(db);
        if (needsSchema && !schemaOwned) {
          return undefined;
        }
        const schemaCookie = options.atomic && needsSchema ? readSqliteSchemaCookie(db) : undefined;
        if (initialize) {
          initializeCanonicalSchema(db, pathname, env, initialization);
        }
        if (needsSchema) {
          ensureStartupMigrationCheckpointSchema(db, pathname, env);
        }
        // Bootstrap/additive repair is a separate mutation boundary. Only unchanged
        // schema can share the initial proof with a subsequent lease claim.
        if (schemaCookie !== undefined && readSqliteSchemaCookie(db) !== schemaCookie) {
          assertSqliteIntegrity(db, pathname);
        }
        return { value: callback(db) };
      };
      // Native bootstrap can rebuild checkpoint tables as STRICT. Foreign keys
      // must be disabled before the enclosing inspection transaction begins.
      const restoreForeignKeys =
        options.atomic === true &&
        isUninitializedNativeStartupDatabase(db) &&
        Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys) === 1;
      if (restoreForeignKeys) {
        db.exec("PRAGMA foreign_keys = OFF;");
      }
      try {
        // Inspection and conditional claim must see the same integrity-proven generation.
        // A deferred snapshot lets WAL writers proceed during verification. A changed
        // snapshot cannot upgrade to a writer, so no proof crosses an intervening commit.
        result = options.atomic
          ? runSqliteDeferredTransactionSync(db, operate, {
              busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
              databaseLabel: pathname,
              operationLabel: "state.startup-checkpoint.inspect-and-claim",
            })
          : operate();
      } finally {
        if (restoreForeignKeys && db.isOpen) {
          db.exec("PRAGMA foreign_keys = ON;");
        }
      }
    } finally {
      db.close();
      if (ownershipAdmitted) {
        ensureOpenClawStatePermissions(pathname, env);
      }
    }
    if (result) {
      return result.value;
    }
    // No callback ran. Reopen and revalidate under schema ownership, retaining
    // that owner until the atomic checkpoint transaction commits or rolls back.
    return withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () => open(true));
  };
  return open(false);
}

/** Admit only recognized native bootstrap; versioned state stays on the read-only path. */
export function initializeNativeOpenClawStateConnection(
  options: OpenClawStateDatabaseOptions,
  initializeCanonicalSchema: (
    db: DatabaseSync,
    pathname: string,
    env: NodeJS.ProcessEnv,
    initialization: StateDatabaseInitialization,
  ) => void,
): void {
  assertOpenClawStateSchemaRepairAllowed(resolveDatabasePath(options));
  if (
    !withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => isUninitializedNativeStartupDatabase(db),
      options,
    )
  ) {
    return;
  }
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () => {
    const db = openNodeSqliteDatabase(pathname);
    try {
      assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
      if (!isUninitializedNativeStartupDatabase(db)) {
        return;
      }
      assertSqliteIntegrity(db, pathname);
      initializeCanonicalSchema(db, pathname, env, { kind: "existing" });
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    }
    ensureOpenClawStatePermissions(pathname, env);
  });
}
