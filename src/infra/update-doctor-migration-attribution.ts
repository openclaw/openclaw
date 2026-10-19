import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { formatErrorMessage } from "./errors.js";
import { assertStateDatabaseAccessAllowed } from "./gateway-state-owner.js";
import type { PostgresSyncConnection } from "./postgres-sync/connection.js";
import { parseSqliteFileGeneration, sameSqliteFileGeneration } from "./sqlite-file-generation.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";
import { observeSqliteNativeClose } from "./sqlite-native-observer.js";
import { runSqliteReadOnlyWorkerSync } from "./sqlite-readonly-worker.js";
import { truncateSqliteWal } from "./sqlite-wal-checkpoint.js";

export type UpdateDoctorMigrationCapture = {
  expected(pathname: string): string | null | undefined;
  assertCurrent(): void;
  accept(pathname: string, before: string | null, after: string | null): void;
  refuse(message: string): void;
};

type MigrationSource = {
  path: string;
  generation: string;
  assertCurrent(this: void): void;
};
type DoctorMigrationBackup = (
  db: DatabaseSync,
  options: { path: string; env: NodeJS.ProcessEnv; tables: readonly string[] },
) => { capture: MigrationSource; backupPath: string };
const captures = new AsyncLocalStorage<{
  capture?: UpdateDoctorMigrationCapture;
  source?: MigrationSource;
  assertMigrationCurrent?: () => void;
  backup?: DoctorMigrationBackup;
}>();

/** Doctor's existing maintenance interval owns the publication receipt. */
export function runWithUpdateDoctorMigrationCapture<T>(
  capture: UpdateDoctorMigrationCapture,
  operation: () => T,
): T {
  // A standalone Doctor backup must not replace its installed updater's inventory.
  const context = captures.getStore();
  return context?.capture
    ? operation()
    : captures.run({ ...context, capture }, () => withArtifactPreservingStateReads(operation));
}

/** Standalone Doctor supplies its existing artifact owner without a command-layer import. */
export function runWithDoctorMigrationBackup<T>(
  backup: DoctorMigrationBackup,
  operation: () => T,
): T {
  return captures.run({ ...captures.getStore(), backup }, operation);
}

export function getDoctorMigrationBackup(
  db: DatabaseSync,
  options: Parameters<DoctorMigrationBackup>[1],
) {
  const context = captures.getStore();
  if (context?.capture) {
    if (context.capture.expected(options.path) !== undefined) {
      throw new Error("Updater migration requires its captured source generation.");
    }
    context.capture.refuse("The migration source path is outside the updater's captured paths.");
    // Relocation cannot certify the installed driver's old path keys. A fresh Doctor
    // backup may still preserve this source without becoming that updater's baseline.
    return captures.run({ ...context, capture: undefined, source: undefined }, () =>
      context.backup?.(db, options),
    );
  }
  return context?.backup?.(db, options);
}

function migrationAuthority(
  capture: UpdateDoctorMigrationCapture,
  pathname: string,
  assertMigrationCurrent?: () => void,
) {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    capture.refuse("Migration did not retain schema maintenance custody.");
    throw new Error("Database migration requires schema maintenance custody.");
  }
  return () => {
    maintenance.assertAdmission();
    if (assertMigrationCurrent) {
      assertMigrationCurrent();
    } else {
      assertStateDatabaseAccessAllowed(pathname);
    }
    capture.assertCurrent();
  };
}

function readSqliteGeneration(pathname: string): string | null {
  const value: unknown = JSON.parse(
    runSqliteReadOnlyWorkerSync(pathname, undefined, "update-generation"),
  );
  if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("Database generation child returned an invalid generation.");
  }
  return value;
}

function readSqliteFiles(pathname: string) {
  return parseSqliteFileGeneration(
    runSqliteReadOnlyWorkerSync(pathname, undefined, "file-generation"),
  );
}

/** Attribute only this committed owner's journal/WAL cleanup and shared-memory removal. */
function observeMigrationClose(
  db: DatabaseSync,
  pathname: string,
  capture: UpdateDoctorMigrationCapture,
  expected: string | null,
  files: ReturnType<typeof readSqliteFiles>,
  assertCurrent: () => void,
) {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  let closed = false;
  observeSqliteNativeClose(db, () => {
    if (closed) {
      return;
    }
    closed = true;
    // A later migration on this handle owns its final postimage.
    if (capture.expected(pathname) !== expected) {
      return;
    }
    try {
      if (getOpenClawDatabaseMaintenanceScope() !== maintenance) {
        throw new Error("SQLite migration close lost its maintenance scope.");
      }
      assertCurrent();
      const closedFiles = readSqliteFiles(pathname);
      // EXCLUSIVE locking retains a cleared rollback journal after COMMIT;
      // returning to NORMAL removes it. A retained journal must still match.
      const expectedFiles = closedFiles.journal ? files : { ...files, journal: undefined };
      if (!sameSqliteFileGeneration(expectedFiles, closedFiles)) {
        throw new Error("SQLite migration source changed before native close.");
      }
      const after = readSqliteGeneration(pathname);
      if (!sameSqliteFileGeneration(closedFiles, readSqliteFiles(pathname))) {
        throw new Error("SQLite migration source changed while verifying native close.");
      }
      assertCurrent();
      capture.accept(pathname, expected, after);
    } catch (error) {
      // Failed attribution must not strand a resource that SQLite already closed.
      capture.refuse(
        `SQLite migration native close could not be verified: ${formatErrorMessage(error)}`,
      );
    }
  });
}

/** A source proof exists only within its verified migration's lexical interval. */
export function getUpdateDoctorMigrationSource(pathname: string) {
  const source = captures.getStore()?.source;
  if (source?.path !== pathname) {
    return undefined;
  }
  const { path, generation, assertCurrent } = source;
  assertCurrent();
  return { path, generation, assertCurrent };
}

export function hasUpdateDoctorMigrationCapture(): boolean {
  return captures.getStore()?.capture !== undefined;
}

/** Retain the source's native exclusion across its commits and isolated postimage read. */
export function runUpdateSqliteMigration<T>(
  db: DatabaseSync,
  pathname: string,
  operation: () => T,
  options?: { retainExclusive?: boolean; created?: boolean },
): T {
  const context = captures.getStore();
  if (!context?.capture) {
    return operation();
  }
  if (context.source?.path === pathname) {
    context.source.assertCurrent();
    return operation();
  }
  const { capture } = context;
  const expected = capture.expected(pathname);
  if (typeof expected !== "string" && !(expected === null && options?.created)) {
    return operation();
  }
  const assertCurrent = migrationAuthority(capture, pathname);
  assertCurrent();
  if (db.isTransaction) {
    throw new Error("Update migration exclusion must precede the source transaction.");
  }
  const mode = db.prepare("PRAGMA locking_mode").get()?.locking_mode; // sqlite-allow-raw -- Preserve connection-local policy.
  return runWithSqliteCleanup(
    {
      release() {
        try {
          if (db.isOpen && mode !== "exclusive" && !options?.retainExclusive) {
            if (db.isTransaction) {
              throw new Error("Update migration left its source transaction open.");
            }
            db.exec("PRAGMA locking_mode=NORMAL; PRAGMA page_count;"); // sqlite-allow-raw -- Release only our connection-local exclusion.
          }
        } catch (error) {
          capture.refuse("SQLite migration native custody could not be released.");
          throw error;
        }
      },
    },
    "Update migration exclusion",
    () => {
      try {
        // Bracket the captured generation and our first native read with exact
        // payload/identity evidence. WAL-index recovery may reset only -shm.
        const files = readSqliteFiles(pathname);
        if (expected === null && (files.database.size !== 0n || files.journal || files.wal)) {
          throw new Error("Created SQLite migration family is no longer empty.");
        }
        const before = expected === null ? null : readSqliteGeneration(pathname);
        assertCurrent();
        if (before !== expected) {
          throw new Error("SQLite migration source changed after update capture.");
        }
        if (mode !== "exclusive") {
          // Start WAL in normal mode: a cold exclusive WAL cannot later return
          // to normal locking without closing the connection or leaving WAL.
          db.prepare("PRAGMA schema_version").get(); // sqlite-allow-raw -- Attach native WAL coordination before retaining exclusion.
        }
        // Exclusive connection mode retains the native lock after each COMMIT.
        db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;"); // sqlite-allow-raw -- Bound the migration's native exclusion.
        const currentFiles = readSqliteFiles(pathname);
        assertCurrent();
        // An empty native BEGIN creates its own rollback journal without changing
        // the main file. No journal or WAL existed before our exclusion attempt.
        const lockedFiles =
          before === null ? { ...currentFiles, journal: undefined } : currentFiles;
        if (!sameSqliteFileGeneration(files, lockedFiles)) {
          throw new Error("SQLite migration source changed after update capture.");
        }
        const source: MigrationSource | undefined =
          before === null ? undefined : { path: pathname, generation: before, assertCurrent };
        return captures.run({ capture, source, assertMigrationCurrent: assertCurrent }, () => {
          const result = operation();
          if (isPromiseLike(result)) {
            throw new Error("Update migration callbacks must remain synchronous.");
          }
          if (db.isTransaction) {
            throw new Error("Update migration publication requires its committed native owner.");
          }
          assertCurrent();
          // Checkpoint under native exclusion so this postimage survives the source handle closing.
          truncateSqliteWal(db, pathname);
          const postimageFiles = readSqliteFiles(pathname);
          const after = readSqliteGeneration(pathname);
          assertCurrent();
          capture.accept(pathname, before, after);
          observeMigrationClose(db, pathname, capture, after, postimageFiles, assertCurrent);
          return result;
        });
      } catch (error) {
        capture.refuse("SQLite migration publication could not be verified.");
        throw error;
      }
    },
  );
}

/** Unknown companions remain outside an older driver's inventory. Their caller retains custody. */
export function beginUpdateSqliteCompanion(db: DatabaseSync, pathname: string, created: boolean) {
  const context = captures.getStore();
  const capture = context?.capture;
  const expected = capture?.expected(pathname);
  if (!capture || expected === undefined) {
    return undefined;
  }
  const assertCurrent = context?.assertMigrationCurrent;
  if (!assertCurrent) {
    capture.refuse("Migration companion has no verified source custody.");
    throw new Error("Migration companion requires verified source custody.");
  }
  assertCurrent();
  const mode = db.prepare("PRAGMA locking_mode").get()?.locking_mode; // sqlite-allow-raw -- The caller retains native exclusion through publication.
  if (mode !== "exclusive") {
    throw new Error("Migration companion requires its exclusive native owner.");
  }
  const before = created && expected === null ? null : readSqliteGeneration(pathname);
  assertCurrent();
  if (before !== expected) {
    capture.refuse("Migration companion changed after update capture.");
    throw new Error("Database migration companion no longer matches its capture.");
  }
  return {
    complete() {
      assertCurrent();
      if (!db.isOpen || db.isTransaction) {
        throw new Error("Migration companion publication requires its committed native owner.");
      }
      const after = readSqliteGeneration(pathname);
      assertCurrent();
      capture.accept(pathname, before, after);
    },
  };
}

/** Called inside the engine's migration transaction, before its first mutation. */
export function beginUpdatePostgresMigration(
  db: PostgresSyncConnection,
  assertMigrationCurrent?: () => void,
) {
  const context = captures.getStore();
  const capture = context?.capture;
  const pathname = db.anchor.location();
  const expected = pathname && capture?.expected(pathname);
  if (!capture || !pathname || typeof expected !== "string") {
    return undefined;
  }
  if (!getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance) {
    capture.refuse("PostgreSQL migration did not retain schema maintenance custody.");
    return undefined;
  }
  const assertCurrent = migrationAuthority(capture, pathname, assertMigrationCurrent);
  assertCurrent();
  // The bridge locks tables and sequences before reading, excluding ordinary SQL writers too.
  const before = db.readRecoveryGeneration(true);
  if (before !== expected) {
    capture.refuse("PostgreSQL changed before migration acquired native custody.");
    throw new Error("PostgreSQL migration source changed after update capture.");
  }
  const source = {
    path: pathname,
    generation: before,
    assertCurrent,
  };
  let publish: (() => void) | undefined;
  return {
    run<T>(operation: () => T): T {
      return captures.run({ capture, source, assertMigrationCurrent: assertCurrent }, operation);
    },
    beforeCommit() {
      assertCurrent();
      const after = db.readRecoveryGeneration(false);
      publish = () => capture.accept(pathname, before, after);
      assertCurrent();
    },
    committed() {
      assertCurrent();
      // The postimage was read under the transaction's native locks. A later writer
      // is detected by the maintenance interval's existing final generation check.
      publish?.();
    },
  };
}
