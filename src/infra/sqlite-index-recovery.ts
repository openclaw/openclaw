import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  requireDirectorySync,
  sha256File,
  syncDirectory,
  syncDirectorySync,
} from "./directory-durability.js";
import { copyFileHandle, flushAndHashFileSync } from "./file-descriptor.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  applySqliteIndexCorruptionRepair,
  inspectSqliteIndexCorruption,
  repairSqliteIndexCorruption,
} from "./sqlite-index-schema.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import {
  createPrivateSqliteTempDirectory,
  createPrivateSqliteTempDirectorySync,
} from "./sqlite-private-directory.js";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import {
  resolveSqliteInspectionSignal,
  runSqliteReadOnlyWorker,
} from "./sqlite-readonly-worker.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "./sqlite-snapshot-source.js";

/** Preserve original pages through the snapshot owner before a Doctor repair writes. */
export async function backupDoctorSqliteRepair(
  pathname: string,
  repair:
    | "index"
    | "session-window"
    | "transcript-headers"
    | "transcript-labels"
    | "media-persistence"
    | "cold-navigation"
    | "transcript-directives",
): Promise<string> {
  // Closing a source descriptor here would release this process's SQLite locks on POSIX.
  const signal = resolveSqliteInspectionSignal();
  const prepared = await prepareSqliteReadOnlyLocation(pathname, {
    preserveSourceArtifacts: true,
    shared: false,
    signal,
  });
  return withPreparedSqliteSnapshot(prepared, async (sourceLocation) => {
    const location = await runSqliteReadOnlyWorker(sourceLocation, {
      mode: "consolidated",
      stagingRoot: path.dirname(sourceLocation),
      signal,
    });
    const directory = await createPrivateSqliteTempDirectory(
      path.dirname(pathname),
      `openclaw-${repair}-recovery-`,
    );
    try {
      const backupPath = path.join(directory, "database.sqlite");
      await using source = await asyncFs.open(location, "r+");
      await source.sync();
      const expected = await sha256File(source, { signal });
      await using output = await asyncFs.open(backupPath, "wx+", 0o600);
      await copyFileHandle(source, output, { signal });
      await output.sync();
      const actual = await sha256File(output, { signal });
      if (actual.digest !== expected.digest || actual.bytes !== expected.bytes) {
        throw new Error(`SQLite ${repair} recovery backup verification failed: ${backupPath}`);
      }
      requireDirectorySync(await syncDirectory(directory), "SQLite recovery directory");
      requireDirectorySync(await syncDirectory(path.dirname(directory)), "SQLite recovery parent");
      signal?.throwIfAborted();
      return backupPath;
    } catch (error) {
      try {
        await asyncFs.rm(directory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw createSqliteLifecycleAggregateError(
          [error, cleanupError],
          `Could not remove incomplete SQLite recovery backup: ${directory}`,
          error,
        );
      }
      throw error;
    }
  });
}

// The published Doctor repair SDK and native startup's shared-state write fence are synchronous.
// Keep their driver here; CLI repair owners use the awaited backup above.
function backupDoctorSqliteRepairSync(pathname: string): string {
  const prepared = prepareSqliteReadOnlyLocationSync(pathname);
  try {
    const snapshot = openNodeSqliteDatabase(prepared.location);
    try {
      snapshot.exec("PRAGMA journal_mode = DELETE;");
    } finally {
      snapshot.close();
    }
    const directory = createPrivateSqliteTempDirectorySync(
      path.dirname(pathname),
      "openclaw-index-recovery-",
    );
    const backupPath = path.join(directory, "database.sqlite");
    const expected = flushAndHashFileSync(prepared.location);
    fs.copyFileSync(prepared.location, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
    if (JSON.stringify(flushAndHashFileSync(backupPath)) !== JSON.stringify(expected)) {
      throw new Error(`SQLite index recovery backup verification failed: ${backupPath}`);
    }
    requireDirectorySync(syncDirectorySync(directory), "SQLite recovery directory");
    requireDirectorySync(syncDirectorySync(path.dirname(directory)), "SQLite recovery parent");
    return backupPath;
  } finally {
    prepared.cleanup();
  }
}

type DoctorIndexRepairOptions = {
  label: string;
  assertCurrent: () => void;
  ftsSchemas?: readonly string[];
  ftsOnly?: boolean;
  describeRepair?: (indexes: readonly string[]) => string;
};

function describeIndexRepair(
  indexes: readonly string[],
  backupPath: string | undefined,
  options: DoctorIndexRepairOptions,
): string[] {
  return indexes.length > 0
    ? [
        `Saved pre-repair SQLite backup: ${backupPath}`,
        options.describeRepair?.(indexes) ??
          `Warning: Rebuilt corrupt ${options.label} SQLite indexes: ${indexes.join(", ")}. No table rows were removed.`,
      ]
    : [];
}

function indexRepairFailure(
  pathname: string,
  backupPath: string | undefined,
  cause: unknown,
): Error {
  const preserved = backupPath ? ` Preserved pre-repair database: ${backupPath}.` : "";
  return new Error(
    `SQLite index repair refused for ${pathname}.${preserved} Preserve the database and its WAL; restore a verified backup or use SQLite recovery. ${String(cause)}`,
    { cause },
  );
}

/** Synchronous SDK/native startup repair retains its existing transaction and backup contract. */
export function repairDoctorSqliteIndexCorruption(
  database: DatabaseSync,
  pathname: string,
  options: DoctorIndexRepairOptions,
): string[] {
  let backupPath: string | undefined;
  let indexes: string[];
  try {
    indexes = repairSqliteIndexCorruption(database, pathname, {
      ftsSchemas: options.ftsSchemas,
      ftsOnly: options.ftsOnly,
      assertCurrent: options.assertCurrent,
      backup: () => {
        options.assertCurrent();
        backupPath = backupDoctorSqliteRepairSync(pathname);
        options.assertCurrent();
      },
    });
  } catch (cause) {
    throw indexRepairFailure(pathname, backupPath, cause);
  }
  return describeIndexRepair(indexes, backupPath, options);
}

/** Prepare without source writes; the original maintenance owner must fence the returned repair. */
export async function prepareDoctorSqliteIndexCorruption(
  database: DatabaseSync,
  pathname: string,
  options: DoctorIndexRepairOptions,
): Promise<() => string[]> {
  let backupPath: string | undefined;
  try {
    options.assertCurrent();
    const plan = inspectSqliteIndexCorruption(database, pathname, options);
    if (plan.indexes.length === 0) {
      return () => [];
    }
    backupPath = await backupDoctorSqliteRepair(pathname, "index");
    options.assertCurrent();
    return () => {
      try {
        options.assertCurrent();
        const indexes = applySqliteIndexCorruptionRepair(
          database,
          pathname,
          plan,
          options.assertCurrent,
        );
        return describeIndexRepair(indexes, backupPath, options);
      } catch (cause) {
        throw indexRepairFailure(pathname, backupPath, cause);
      }
    };
  } catch (cause) {
    throw indexRepairFailure(pathname, backupPath, cause);
  }
}

/** Direct Doctor callers already hold their maintenance fence through this whole operation. */
export async function repairDoctorSqliteIndexCorruptionAsync(
  database: DatabaseSync,
  pathname: string,
  options: DoctorIndexRepairOptions,
): Promise<string[]> {
  return (await prepareDoctorSqliteIndexCorruption(database, pathname, options))();
}
