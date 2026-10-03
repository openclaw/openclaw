import fs from "node:fs";
import { sha256Hex } from "./crypto-digest.js";
import { hashFileDescriptorSync } from "./file-descriptor.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode } from "./path-guards.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "./sqlite-file-generation.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { truncateSqliteWal } from "./sqlite-wal-checkpoint.js";
import { readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";

export type UpdateDatabaseGenerations = Record<string, string | null>;
export type UpdateDatabaseWriteReceipt = {
  unchanged: boolean;
  fromGenerations?: UpdateDatabaseGenerations;
  generations: UpdateDatabaseGenerations;
};

function readCommittedContent(pathname: string): string {
  // Checkpoint only a private copy: opening the source would compete with the
  // restore owner's native exclusion. SQLite owns WAL/journal interpretation.
  const prepared = prepareSqliteReadOnlyLocationSyncInProcess(pathname);
  return runWithSqliteCleanup({ release: prepared.cleanup }, "Database generation snapshot", () => {
    const database = openNodeSqliteDatabase(prepared.location);
    runWithSqliteCleanup(
      { release: () => database.close() },
      "Database generation checkpoint",
      () => truncateSqliteWal(database, prepared.location),
    );
    const descriptor = fs.openSync(prepared.location, "r");
    return runWithSqliteCleanup(
      { release: () => fs.closeSync(descriptor) },
      "Database generation digest",
      () => hashFileDescriptorSync(descriptor).sha256,
    );
  });
}

function readWalIndexHeader(pathname: string): Buffer | null {
  const file = `${pathname}-shm`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "r");
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const header = Buffer.alloc(96);
    // SQLite publishes copy 1 before copy 0. Read in the opposite order and
    // reject a torn publication; bytes 96+ contain mutable reader/lock bookkeeping.
    const first = fs.readSync(descriptor, header, 0, 48, 0);
    const second = fs.readSync(descriptor, header, 48, 48, 48);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (
      !before.isFile() ||
      !current.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      first !== 48 ||
      second !== 48 ||
      !header.subarray(0, 48).equals(header.subarray(48, 96))
    ) {
      throw new Error(`SQLite WAL commit header is unavailable or changing: ${pathname}`);
    }
    return header;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Run only in an isolated process, after all source handles drain, or under a
 * schema-maintenance owner before live reads are admitted: raw close
 * can release this process's SQLite locks. Inspect only the supplied inventory. */
export function readUpdateDatabaseGenerations(paths: readonly string[]): UpdateDatabaseGenerations {
  return Object.fromEntries(
    paths.map((pathname) => {
      const entry = fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
      if (!entry) {
        if (
          ["-wal", "-journal"].some((suffix) =>
            fs.lstatSync(`${pathname}${suffix}`, { throwIfNoEntry: false }),
          )
        ) {
          throw new Error(`Database is absent but retained journal data exists: ${pathname}`);
        }
        return [pathname, null];
      }
      if (!entry.isFile()) {
        throw new Error(`Database generation requires a regular file: ${pathname}`);
      }
      const before = readWalIndexHeader(pathname);
      const generation = readStableSqliteFileGeneration(pathname);
      const content = readCommittedContent(pathname);
      const current = readStableSqliteFileGeneration(pathname);
      const after = readWalIndexHeader(pathname);
      if (
        !sameSqliteFileGeneration(generation, current) ||
        (before === null ? after !== null : !after?.equals(before)) ||
        (generation.wal && generation.wal.size > 0n && after?.[12] !== 1)
      ) {
        throw new Error(`SQLite WAL commit publication could not be verified: ${pathname}`);
      }
      // Checkpoints preserve iChange and the last committed frame checksum,
      // including TRUNCATE, which resets frame count and salts.
      // A reversed write leaving identical bytes and write evidence is
      // indistinguishable from no write; restoring loses no later data.
      return [
        pathname,
        sha256Hex(
          JSON.stringify([
            generation.database.dev.toString(),
            generation.database.ino.toString(),
            readDatabaseIdentityBirthtime(entry),
            content,
            after?.subarray(8, 12).toString("hex") ?? null,
            after?.subarray(24, 32).toString("hex") ?? null,
          ]),
        ),
      ];
    }),
  );
}
