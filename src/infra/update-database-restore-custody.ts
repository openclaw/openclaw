import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { sameFileIdentity, type FileIdentityStat } from "./fs-safe-advanced.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { throwSqliteLifecycleErrors } from "./sqlite-coordinator.js";

/** Lock primitive: the same process retains native SQLite exclusion and performs
 * the displacement. A separate lock-holder process could die before our rename.
 * No source descriptor may be opened/closed here outside SQLite: POSIX close()
 * would drop every process lock on that inode, including SQLite's own lock. */
export function acquireUpdateDatabaseRestoreCustody(paths: readonly string[]) {
  if (process.platform === "win32" || process.versions.bun) {
    throw new Error(
      "Native database displacement custody is unavailable on this runtime; preserve databases and snapshots for manual recovery.",
    );
  }
  // Inspect every family before opening any native connection. In particular,
  // SQLite must not follow an aliased WAL or recover an unverified hot journal.
  const families = paths.map((pathname) => {
    const files = ["", "-wal", "-shm", "-journal"].map((suffix) => {
      const info = fs.lstatSync(pathname + suffix, { bigint: true, throwIfNoEntry: false });
      if (info && (!info.isFile() || info.nlink !== 1n)) {
        throw new Error(
          "Native database custody requires an unaliased regular file: " + pathname + suffix,
        );
      }
      return info;
    });
    const [identity, previousWal, shm, journal] = files;
    if ((!identity && (previousWal || shm || journal)) || (journal && journal.size > 0n)) {
      throw new Error("Native database custody requires settled journal artifacts: " + pathname);
    }
    return { pathname, identity, previousWal };
  });
  using pending = new DisposableStack();
  const owners: Array<{ path: string; database: DatabaseSync; identity: fs.BigIntStats }> = [];
  for (const { pathname, identity, previousWal } of families) {
    if (!identity) {
      continue;
    }
    const wal = pathname + "-wal";
    const database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname));
    pending.defer(() => {
      const errors: unknown[] = [];
      try {
        if (database.isTransaction) {
          // sqlite-allow-raw -- Settle the retained native transaction before releasing custody.
          database.exec("ROLLBACK");
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        database.close();
      } catch (error) {
        errors.push(error);
      }
      throwSqliteLifecycleErrors(errors, "Database restore native settlement failed");
    });
    // EXCLUSIVE locking mode retains the main-file lock even between native
    // transactions. Unlike BEGIN IMMEDIATE alone, it excludes WAL readers too.
    // sqlite-allow-raw -- Native EXCLUSIVE mode retains inode exclusion across journal settlement.
    database.exec(
      "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE",
    );
    if (!sameFileIdentity(identity, fs.lstatSync(pathname, { bigint: true }))) {
      throw new Error("Database changed during native custody admission: " + pathname);
    }
    // A cold WAL open creates an empty WAL even though this owner never writes.
    // Under the exclusive native lock, discard only that new, zero-byte file
    // before comparing the original physical generation. No descriptor close.
    const createdWal = fs.lstatSync(wal, { bigint: true, throwIfNoEntry: false });
    if (!previousWal && createdWal?.isFile() && createdWal.nlink === 1n && createdWal.size === 0n) {
      fs.unlinkSync(wal);
    }
    owners.push({ path: pathname, database, identity });
  }
  const assertHeld = () => {
    for (const { database } of owners) {
      if (!database.isOpen || !database.isTransaction) {
        throw new Error("Database restore lost its native write exclusion");
      }
    }
  };
  const retained = pending.move();
  return {
    assertHeld,
    hasSource(pathname: string) {
      assertHeld();
      return owners.some((owner) => owner.path === pathname);
    },
    assertSource(pathname: string, expected: FileIdentityStat) {
      assertHeld();
      const owner = owners.find(
        (entry) => entry.path === pathname || entry.path + "-shm" === pathname,
      );
      if (
        !owner ||
        !sameFileIdentity(expected, fs.lstatSync(pathname, { bigint: true })) ||
        !sameFileIdentity(owner.identity, fs.lstatSync(owner.path, { bigint: true }))
      ) {
        throw new Error("Database restore source changed under native custody: " + pathname);
      }
    },
    settleJournal() {
      assertHeld();
      for (const { path: pathname, database } of owners) {
        // Only after the expected generation matches under exclusion: checkpoint
        // the admitted WAL into the retained database, while EXCLUSIVE mode keeps
        // the native main-file lock. MEMORY is connection-local and this owner
        // performs no SQL data writes. Close can no longer unlink a new live
        // database's WAL/journal using the old connection's original pathname.
        // sqlite-allow-raw -- End the transaction without releasing EXCLUSIVE connection custody.
        database.exec("ROLLBACK");
        if (
          // sqlite-allow-raw -- Settle the old journal under custody before displacing its pathname.
          database.prepare("PRAGMA journal_mode=MEMORY").get()?.journal_mode !== "memory"
        ) {
          throw new Error("Database restore could not settle native journal custody: " + pathname);
        }
        // sqlite-allow-raw -- Reenter native exclusion before displacement, without application writes.
        database.exec("BEGIN EXCLUSIVE");
        // EXCLUSIVE WAL uses heap coordination; an earlier process may have
        // left SHM bookkeeping that this connection never mapped. Retain it with
        // the displaced family, before the main-file name becomes available.
        if (["-wal", "-journal"].some((suffix) => fs.existsSync(pathname + suffix))) {
          throw new Error("Database restore retained an unsettled native sidecar: " + pathname);
        }
      }
    },
    release() {
      retained.dispose();
    },
    [Symbol.dispose]() {
      retained.dispose();
    },
  };
}
