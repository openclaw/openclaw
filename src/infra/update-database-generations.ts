import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "./crypto-digest.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { runWithSqliteCoordinator } from "./sqlite-coordinator.js";
import {
  readStableSqliteFileGeneration,
  serializeSqliteFileGeneration,
  type SqliteFileGeneration,
} from "./sqlite-file-generation.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import { readUpdateDatabaseImage } from "./update-database-image.js";

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
function inspectUpdateDatabaseGenerations(
  paths: readonly string[],
  observe?: (pathname: string, generation: SqliteFileGeneration, shm: Buffer | null) => void,
): UpdateDatabaseGenerations {
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
      observe?.(pathname, generation, after);
      return [
        pathname,
        sha256Hex(
          JSON.stringify([
            serializeSqliteFileGeneration(generation),
            after?.toString("hex") ?? null,
          ]),
        ),
      ];
    }),
  );
}

export function readUpdateDatabaseGenerations(paths: readonly string[]): UpdateDatabaseGenerations {
  return inspectUpdateDatabaseGenerations(paths);
}

export type UpdateDatabasePostimages = Record<
  string,
  { sha256: string; sizeBytes: number; sidecars: boolean }
>;
/** Same physical inspection owner, exposing only the captured publication facts. */
export function readUpdateDatabasePostimages(paths: readonly string[]): UpdateDatabasePostimages {
  const result: UpdateDatabasePostimages = {};
  inspectUpdateDatabaseGenerations(paths, (pathname, generation, shm) => {
    const sizeBytes = Number(generation.database.size);
    if (!Number.isSafeInteger(sizeBytes)) {
      throw new Error("Database postimage size is unverifiable");
    }
    result[pathname] = {
      sha256: generation.database.sha256,
      sizeBytes,
      sidecars: Boolean(generation.wal || generation.journal || shm),
    };
  });
  if (paths.some((pathname) => !Object.hasOwn(result, pathname))) {
    throw new Error("Published database disappeared before postimage verification");
  }
  return result;
}

function readUpdateDatabaseImages(paths: readonly string[]): UpdateDatabaseGenerations {
  return Object.fromEntries(
    paths.map((pathname) => {
      const before = fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
      if (!before) {
        if (["-wal", "-journal"].some((suffix) => fs.existsSync(pathname + suffix))) {
          throw new Error("Database is absent but retained journal data exists: " + pathname);
        }
        return [pathname, null];
      }
      if (!before.isFile()) {
        throw new Error("Database generation requires a regular file: " + pathname);
      }
      const prepared = prepareSqliteReadOnlyLocationSyncInProcess(pathname);
      return runWithSqliteCoordinator(
        {
          release() {
            if (!prepared.cleanup()) {
              throw new Error("Database image snapshot cleanup failed: " + prepared.location);
            }
          },
        },
        "Database write image snapshot",
        () => {
          const database = openNodeSqliteDatabase(prepared.location, { readOnly: true });
          return runWithSqliteCoordinator(
            { release: () => database.close() },
            "Database write image reader",
            () => {
              // sqlite-allow-raw -- Connection-local read-only inspection policy, not application SQL.
              database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
              return runSqliteDeferredTransactionSync(database, () => {
                const generation = readUpdateDatabaseImage(database);
                const after = fs.lstatSync(pathname, { bigint: true });
                if (before.dev !== after.dev || before.ino !== after.ino) {
                  throw new Error("Database generation target was replaced: " + pathname);
                }
                return [pathname, generation];
              });
            },
          );
        },
      );
    }),
  );
}

export type UpdateDatabaseWriteInspection = {
  generations: UpdateDatabaseGenerations;
  images: UpdateDatabaseGenerations;
};

/** Keep the shipped physical-generation contract. The paired semantic images
 * are private writer evidence, and must describe the same stable source bytes.
 * This runs in its isolated process: raw descriptor closes cannot drop a writer's locks. */
export function readUpdateDatabaseWriteInspection(
  paths: readonly string[],
): UpdateDatabaseWriteInspection {
  const before = readUpdateDatabaseGenerations(paths);
  const images = readUpdateDatabaseImages(paths);
  const generations = readUpdateDatabaseGenerations(paths);
  if (!isDeepStrictEqual(before, generations)) {
    throw new Error("Database changed while pairing its physical generation and SQL image");
  }
  return { generations, images };
}
