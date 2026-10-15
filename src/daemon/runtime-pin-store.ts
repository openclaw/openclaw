// Daemon intent is local even when the selected shared-state engine is remote.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { resolveStateDir } from "../config/paths.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { hasErrnoCode } from "../infra/errno.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion, writeSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  createPrivateWindowsDirectory,
  createPrivateWindowsFile,
} from "../infra/windows-private-directory.js";

type DaemonRuntimePinRow = { state_key: string; value_json: string; updated_at_ms: number };
export const DAEMON_RUNTIME_PIN_SCHEMA_VERSION = 1;
const schema = `CREATE TABLE daemon_runtime_pins (
  state_key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;`;
export type DaemonRuntimePinDatabase = { daemon_runtime_pins: DaemonRuntimePinRow };
const schemaAdmission: SqliteDatabaseAdmissionKey<true> = {
  name: "daemon.runtime-pins.schema-v1",
  schemaDependent: true,
  read: (value) => (value === true ? true : undefined),
};

export function resolveDaemonRuntimePinStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "control", "services.sqlite");
}

/** CLI/service one-shots and migration workers use the same local owner. */
export function withDaemonRuntimePinStore<T>(
  env: NodeJS.ProcessEnv,
  writable: boolean,
  operation: (db: DatabaseSync) => T,
): T | undefined {
  const pathname = resolveDaemonRuntimePinStorePath(env);
  const directory = path.dirname(pathname);
  const parent = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    parent &&
    (!parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (process.getuid && parent.uid !== process.getuid()))
  ) {
    throw new Error("Runtime pin store directory is unsafe.");
  }
  if (!parent && !writable) {
    return undefined;
  }
  if (writable) {
    if (!parent && process.platform === "win32") {
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      try {
        createPrivateWindowsDirectory(directory);
      } catch (error) {
        if (!(error instanceof FsSafeError && error.code === "already-exists")) {
          throw error;
        }
      }
    } else {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    applyPrivateModeSync(directory, 0o700);
    if (!fs.existsSync(pathname)) {
      try {
        if (process.platform === "win32") {
          createPrivateWindowsFile(pathname).close();
        } else {
          fs.closeSync(fs.openSync(pathname, "wx", 0o600));
        }
      } catch (error) {
        if (
          !hasErrnoCode(error, "EEXIST") &&
          !(error instanceof FsSafeError && error.code === "already-exists")
        ) {
          throw error;
        }
      }
    }
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
          runSqliteImmediateTransactionSync(db, () => {
            db.exec(schema);
            writeSqliteUserVersion(db, DAEMON_RUNTIME_PIN_SCHEMA_VERSION);
          });
        } else if (version !== DAEMON_RUNTIME_PIN_SCHEMA_VERSION) {
          throw new Error(
            `Runtime pin store has unsupported schema version ${String(version)}. Use a compatible OpenClaw version.`,
          );
        }
        if (version !== 0) {
          assertSqliteSchemaContains(db, "Runtime pin store", schema);
          assertSqliteIntegrity(db, "Runtime pin store");
        }
        publishSqliteDatabaseAdmission(db, schemaAdmission, true);
      }
      return writable ? runSqliteImmediateTransactionSync(db, () => operation(db)) : operation(db);
    } finally {
      if (db.isOpen) {
        db.close();
      }
    }
  } finally {
    fs.closeSync(opened.fd);
  }
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
