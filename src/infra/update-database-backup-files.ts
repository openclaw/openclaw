import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { hasNodeErrorCode } from "./path-guards.js";

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
      let info;
      try {
        info = await fs.lstat(file, { bigint: true });
      } catch (error) {
        if (suffix && hasNodeErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
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
