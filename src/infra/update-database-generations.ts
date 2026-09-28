import fs from "node:fs";
import { sha256Hex } from "./crypto-digest.js";
import { hasNodeErrorCode } from "./path-guards.js";
import {
  readStableSqliteFileGeneration,
  serializeSqliteFileGeneration,
} from "./sqlite-file-generation.js";

export type UpdateDatabaseGenerations = Record<string, string | null>;
export type UpdateDatabaseWriteReceipt = {
  unchanged: boolean;
  generations: UpdateDatabaseGenerations;
};

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

/** Run only in an isolated process or after all source handles drain: raw close
 * can release this process's SQLite locks. Inspect only the supplied inventory. */
export function readUpdateDatabaseGenerations(paths: readonly string[]): UpdateDatabaseGenerations {
  return Object.fromEntries(
    paths.map((pathname) => {
      const entry = fs.lstatSync(pathname, { throwIfNoEntry: false });
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
      const after = readWalIndexHeader(pathname);
      if (
        (before === null ? after !== null : !after?.equals(before)) ||
        (generation.wal && generation.wal.size > 0n && after?.[12] !== 1)
      ) {
        throw new Error(`SQLite WAL commit publication could not be verified: ${pathname}`);
      }
      // Native exclusion may create an empty WAL without a write. It contains
      // no commit; retain every other physical fingerprint and publication header.
      const writeGeneration =
        generation.wal?.size === 0n ? { ...generation, wal: undefined } : generation;
      return [
        pathname,
        sha256Hex(
          JSON.stringify([
            serializeSqliteFileGeneration(writeGeneration),
            after?.toString("hex") ?? null,
          ]),
        ),
      ];
    }),
  );
}
