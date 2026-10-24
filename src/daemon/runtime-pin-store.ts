import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { getDatabaseEngineInput } from "../infra/database-engine/context.js";
import { hasErrnoCode } from "../infra/errno.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { preparePrivateStoreFileSync } from "../infra/private-store-file.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion, writeSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { runUpdateSqliteMigration } from "../infra/update-doctor-migration-attribution.js";
import { DAEMON_RUNTIME_PIN_SCHEMA_SQL } from "./runtime-pin-schema.js";

export const DAEMON_RUNTIME_PIN_SCHEMA_VERSION = 1;
export type DaemonRuntimePinDatabase = {
  daemon_runtime_pins: { state_key: string; value_json: string; updated_at_ms: number };
  daemon_runtime_pin_migration: {
    version: number;
    source_state: string;
    phase: "copied" | "complete";
    updated_at: number;
  };
};
const schemaAdmission: SqliteDatabaseAdmissionKey<true> = {
  name: "daemon.runtime-pins.schema-v1",
  schemaDependent: true,
  read: (value) => (value === true ? true : undefined),
};

export function resolveDaemonRuntimePinStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "control", "services.sqlite");
}

function withDaemonRuntimePinDatabase<T>(
  env: NodeJS.ProcessEnv,
  writable: boolean,
  operation: (db: DatabaseSync) => T,
): T | undefined {
  const pathname = resolveDaemonRuntimePinStorePath(env);
  const directory = path.dirname(pathname);
  const parent = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (parent && (!parent.isDirectory() || (process.getuid && parent.uid !== process.getuid()))) {
    throw new Error("Runtime pin store directory is unsafe.");
  }
  if (!parent && !writable) {
    return undefined;
  }
  let created = false;
  if (writable) {
    created = preparePrivateStoreFileSync(pathname, Boolean(parent));
  }
  const opened = openRootFileSync({
    absolutePath: pathname,
    rootPath: directory,
    boundaryLabel: "runtime pin store",
    rejectSymlinks: true,
  });
  if (!opened.ok) {
    if (hasErrnoCode(opened.error, "ENOENT") && !writable) {
      return undefined;
    }
    throw new Error("Runtime pin store cannot be safely opened.", { cause: opened.error });
  }
  try {
    const stat = fs.fstatSync(opened.fd);
    if (
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error("Runtime pin store owner is unsafe.");
    }
    const db = openNodeSqliteDatabase(
      writable ? resolveExistingSqliteFileUri(pathname) : pathname,
      {
        readOnly: !writable,
        timeout: 5000,
      },
    );
    try {
      return writable
        ? runUpdateSqliteMigration(db, pathname, () => operation(db), { created })
        : operation(db);
    } finally {
      db.close();
    }
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function withDaemonRuntimePinStore<T>(
  env: NodeJS.ProcessEnv,
  writable: boolean,
  operation: (db: DatabaseSync) => T,
): T | undefined {
  return withDaemonRuntimePinDatabase(env, writable, (db) => {
    if (!getSqliteDatabaseAdmission(db, schemaAdmission)) {
      const version = readSqliteUserVersion(db);
      if (
        version === 0 &&
        !db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()
      ) {
        if (!writable) {
          return undefined;
        }
        db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
        return runSqliteImmediateTransactionSync(db, () => {
          db.exec(DAEMON_RUNTIME_PIN_SCHEMA_SQL);
          writeSqliteUserVersion(db, DAEMON_RUNTIME_PIN_SCHEMA_VERSION);
          publishSqliteDatabaseAdmission(db, schemaAdmission, true);
          return operation(db);
        });
      } else if (version !== DAEMON_RUNTIME_PIN_SCHEMA_VERSION) {
        throw new Error(
          `Runtime pin store has unsupported schema version ${String(version)}. Use a compatible OpenClaw version.`,
        );
      }
      assertSqliteSchemaContains(db, "Runtime pin store", DAEMON_RUNTIME_PIN_SCHEMA_SQL);
      assertSqliteIntegrity(db, "Runtime pin store");
      publishSqliteDatabaseAdmission(db, schemaAdmission, true);
    }
    return writable ? runSqliteImmediateTransactionSync(db, () => operation(db)) : operation(db);
  });
}

/** The versioned receipt is independent of pin-data admission until a pin is used. */
export function readDaemonRuntimePinMigrationReceipt(env: NodeJS.ProcessEnv) {
  return withDaemonRuntimePinDatabase(env, false, (db) => {
    try {
      return executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<DaemonRuntimePinDatabase>(db)
          .selectFrom("daemon_runtime_pin_migration")
          .select(["source_state", "phase"])
          .where("version", "=", 1),
      );
    } catch (error) {
      // A crash before schema creation leaves an empty file; normal migration admits it.
      if (
        error instanceof Error &&
        /no such table: daemon_runtime_pin_migration/u.test(error.message)
      ) {
        return undefined;
      }
      throw error;
    }
  });
}

export function readDaemonRuntimePinValue(db: DatabaseSync, key: string): unknown {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DaemonRuntimePinDatabase>(db)
      .selectFrom("daemon_runtime_pins")
      .select("value_json")
      .where("state_key", "=", key),
  );
  return row ? JSON.parse(row.value_json) : undefined;
}

const unshippedMigrations = new Set<string>();
export function completeUnshippedDaemonRuntimePinMigration(env: NodeJS.ProcessEnv): boolean {
  if (!getDatabaseEngineInput("state")) {
    return false;
  }
  const pathname = resolveDaemonRuntimePinStorePath(env);
  if (!unshippedMigrations.has(pathname)) {
    const receipt = readDaemonRuntimePinMigrationReceipt(env);
    if (receipt?.phase === "complete" && receipt.source_state === "none/unshipped") {
      unshippedMigrations.add(pathname);
      return true;
    }
    withDaemonRuntimePinStore(env, true, (db) =>
      db
        .prepare(`INSERT INTO daemon_runtime_pin_migration VALUES (1, 'none/unshipped', 'complete', ?)
        ON CONFLICT(version) DO UPDATE SET source_state='none/unshipped', phase='complete', updated_at=excluded.updated_at`)
        .run(Date.now()),
    );
    unshippedMigrations.add(pathname);
  }
  return true;
}
