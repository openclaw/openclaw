import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { ignoreMissingPath } from "./errno.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { SqliteWalCheckpointBusyError, truncateSqliteWal } from "./sqlite-wal-checkpoint.js";

export async function prepareRestorableDatabaseFiles(
  databases: readonly string[],
  stopped = false,
) {
  const identities = await inspectRestorableDatabaseFiles(databases);
  const checkpointed = new Set<string>();
  if (!stopped) {
    return { identities, checkpointed };
  }
  const walSources = databases.filter(
    (file) => identities.has(`${file}-wal`) && !identities.has(`${file}-journal`),
  );
  for (const file of walSources) {
    // The native updater holds its maintenance lease until this child joins.
    // Fold committed WAL frames once before capturing the recovery image.
    using database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(file));
    try {
      truncateSqliteWal(database, file);
      checkpointed.add(file);
    } catch (error) {
      // A read-only probe may pin WAL; retain the existing verified capture path.
      if (!(error instanceof SqliteWalCheckpointBusyError)) {
        throw error;
      }
    }
  }
  return {
    // Even a busy checkpoint can have folded committed pages into the main file.
    identities: walSources.length ? await inspectRestorableDatabaseFiles(databases) : identities,
    checkpointed,
  };
}

/** Fence every durable database file an update rollback restores. */
export async function inspectRestorableDatabaseFiles(
  databases: readonly string[],
  previous?: ReadonlyMap<string, BigIntStats>,
  stopped = false,
) {
  const identities = new Map<string, BigIntStats>();
  for (const database of databases) {
    // Readers mutate/recreate the transient WAL index; only durable files fence capture.
    for (const suffix of ["", "-wal", "-journal"]) {
      const file = `${database}${suffix}`;
      // Only sidecars may be absent; without a handler a missing main file still rejects.
      const info = await fs
        .lstat(file, { bigint: true })
        .catch(suffix ? ignoreMissingPath : undefined);
      if (!info) {
        continue;
      }
      if (!info.isFile() || info.nlink !== 1n) {
        throw new Error(
          `Update database rollback requires a regular file with one link: ${file}. Resolve database aliases before retrying; the databases have not been migrated.`,
        );
      }
      const before = previous?.get(file);
      if (
        before &&
        !(stopped ? sameFileMutationFingerprint(before, info) : sameFileIdentity(before, info))
      ) {
        throw new Error(`Update database file changed during backup: ${file}.`);
      }
      // Readers can create an empty WAL beside a checkpointed database.
      if (suffix !== "-wal" || info.size !== 0n) {
        identities.set(file, info);
      }
    }
  }
  if (stopped && previous) {
    const changed = [...previous.keys(), ...identities.keys()].find(
      (file) => previous.has(file) !== identities.has(file),
    );
    if (changed) {
      throw new Error(`Update database journal state changed during stopped backup: ${changed}.`);
    }
  }
  return identities;
}
