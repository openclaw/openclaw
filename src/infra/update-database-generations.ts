import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./crypto-digest.js";
import { ignoreMissingPath } from "./errno.js";
import { hashFileDescriptorSync } from "./file-descriptor.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  createSqliteFileGenerationReader,
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  serializeSqliteFileGeneration,
  type SqliteFileGeneration,
} from "./sqlite-file-generation.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";
import { captureSqlitePrivateSnapshotFamily } from "./sqlite-private-snapshot-fork.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import type {
  PreparedSqliteReadOnlyLocation,
  PreparedSqliteSnapshotSource,
} from "./sqlite-readonly-location.types.js";
import {
  assertPublishedFileIdentitySync,
  sameFileStatFingerprint,
} from "./sqlite-snapshot-file.js";
import { truncateSqliteWal } from "./sqlite-wal-checkpoint.js";
import {
  databaseFileIdentityKey,
  readDatabaseIdentityBirthtime,
} from "./sqlite-worker-identity.js";

export type UpdateDatabaseGenerations = Record<string, string | null>;
export type UpdateDatabaseGenerationPair = {
  committed: UpdateDatabaseGenerations;
  physical: UpdateDatabaseGenerations;
  emptyReaderAlternates: Record<string, string>;
};
export type UpdateDatabaseWriteReceipt = {
  unchanged: boolean;
  fromGenerations?: UpdateDatabaseGenerations;
  generations: UpdateDatabaseGenerations;
  historicalScans?: import("./update-doctor-scan-receipts.js").UpdateDoctorHistoricalScans;
};

function readCommittedContent(
  pathname: string,
  prepared: PreparedSqliteReadOnlyLocation,
  inspectImage?: (imagePath: string, sourcePath: string) => void,
  retain?: () => boolean,
) {
  // Checkpoint only a private copy: opening the source would compete with the
  // restore owner's native exclusion. SQLite owns WAL/journal interpretation.
  const database = openNodeSqliteDatabase(prepared.location);
  runWithSqliteCleanup({ release: () => database.close() }, "Database generation checkpoint", () =>
    truncateSqliteWal(database, prepared.location),
  );
  // Native admission still rejects malformed catalogs. With no recovery data,
  // checkpointing leaves the digest-bound private image unchanged.
  inspectImage?.(prepared.location, pathname);
  const keep = retain?.();
  const family = keep
    ? captureSqlitePrivateSnapshotFamily(
        prepared.location,
        prepared.cleanupRoot ?? path.dirname(prepared.location),
      )
    : undefined;
  if (keep && !family) {
    throw new Error("Database generation private image cannot be retained");
  }
  const content = prepared.journalFreeContent;
  if (content) {
    assertPublishedFileIdentitySync(prepared.location, content.identity, content);
    return { sha256: content.sha256, family };
  }
  const descriptor = fs.openSync(prepared.location, "r");
  const sha256 = runWithSqliteCleanup(
    { release: () => fs.closeSync(descriptor) },
    "Database generation digest",
    () => hashFileDescriptorSync(descriptor).sha256,
  );
  return { sha256, family };
}

function readWalIndexHeader(pathname: string): Buffer | null {
  const file = `${pathname}-shm`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "r");
  } catch (error) {
    return ignoreMissingPath(error) ?? null;
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
      [after, current].some((stat) => before.dev !== stat.dev || before.ino !== stat.ino) ||
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

type DatabaseGenerationObservation = {
  generation: string | null;
  physical: string | null;
  emptyReaderAlternate?: string;
  preparedSource?: PreparedSqliteSnapshotSource;
};

export type SqliteDatabaseGenerationReceipt = Readonly<{
  sourcePath: string;
  generation: string;
  physical: string;
}>;

function readGenerationFamily(pathname: string) {
  const entries = ["", "-journal", "-wal"].map((suffix) =>
    fs.lstatSync(`${pathname}${suffix}`, { bigint: true, throwIfNoEntry: false }),
  );
  if (!entries[0] && entries.slice(1).some(Boolean)) {
    throw new Error(`Database is absent but retained journal data exists: ${pathname}`);
  }
  if (entries.some((entry) => entry && !entry.isFile())) {
    throw new Error(`Database generation requires a regular file: ${pathname}`);
  }
  // Empty WAL files carry no frames, but must still pass the regular-file gate.
  return entries.map((entry, index) => (index === 2 && entry?.size === 0n ? undefined : entry));
}

function verifyGenerationFamily(
  pathname: string,
  before: ReturnType<typeof readGenerationFamily>,
  generation: SqliteFileGeneration,
) {
  const after = readGenerationFamily(pathname);
  const files = [
    generation.database,
    generation.journal,
    generation.wal?.size === 0n ? undefined : generation.wal,
  ];
  if (
    files.some((file, index) =>
      [before[index], after[index]].some((entry) =>
        file === undefined ? entry !== undefined : !entry || !sameFileStatFingerprint(entry, file),
      ),
    )
  ) {
    throw new Error(`SQLite file generation changed while reading: ${pathname}`);
  }
}

function serializePhysicalGeneration(generation: SqliteFileGeneration, header: Buffer | null) {
  // Published 2026.9.33/34 parents bind this exact family and full WAL-header format.
  return sha256Hex(
    JSON.stringify([
      serializeSqliteFileGeneration(
        generation.wal?.size === 0n ? { ...generation, wal: undefined } : generation,
      ),
      header?.toString("hex") ?? null,
    ]),
  );
}

/** Fresh source bytes may reuse only a successful same-path SQLite observation. */
export function readUnchangedUpdateDatabaseGeneration(
  pathname: string,
  receipt: SqliteDatabaseGenerationReceipt,
): string | undefined {
  if (receipt.sourcePath !== pathname) {
    return undefined;
  }
  const entries = readGenerationFamily(pathname);
  if (!entries[0]) {
    return undefined;
  }
  const before = readWalIndexHeader(pathname);
  // Never carry a digest reader across observations: coarse clocks can hide writes.
  const current = readStableSqliteFileGeneration(pathname);
  const after = readWalIndexHeader(pathname);
  verifyGenerationFamily(pathname, entries, current);
  if (
    (before === null ? after !== null : !after?.equals(before)) ||
    (current.wal && current.wal.size > 0n && after?.[12] !== 1)
  ) {
    throw new Error(`SQLite WAL commit publication could not be verified: ${pathname}`);
  }
  return serializePhysicalGeneration(current, after) === receipt.physical
    ? receipt.generation
    : undefined;
}

/** Isolated raw-close owner; retained images must stay inside a retained snapshot-work scope. */
export function readUpdateDatabaseGeneration(
  pathname: string,
  inspectImage?: (imagePath: string, sourcePath: string) => void,
  retain?: { stagingRoot: string; accept: () => boolean },
): DatabaseGenerationObservation {
  const entries = readGenerationFamily(pathname);
  const entry = entries[0];
  if (!entry) {
    return { generation: null, physical: null };
  }
  const before = readWalIndexHeader(pathname);
  // Acquisition binds this provisional observation; the final stable read
  // below verifies the whole family before its generation can be published.
  const readGeneration = createSqliteFileGenerationReader();
  const generation = readGeneration(pathname);
  const prepared = prepareSqliteReadOnlyLocationSyncInProcess(
    pathname,
    retain?.stagingRoot,
    { key: `file:${databaseFileIdentityKey(generation.database)}` },
    !generation.journal && (generation.wal?.size ?? 0n) === 0n
      ? { sha256: generation.database.sha256, sizeBytes: Number(generation.database.size) }
      : undefined,
  );
  let retained = false;
  return runWithSqliteCleanup(
    {
      release: () => {
        if (retained) {
          return;
        }
        if (!retain) {
          prepared.cleanup();
          return;
        }
        try {
          if (!prepared.cleanup()) {
            throw new Error("Database generation snapshot cleanup did not settle");
          }
        } catch (cause) {
          throw new SqliteSnapshotCleanupError("Database generation snapshot cleanup failed", {
            cause,
          });
        }
      },
    },
    "Database generation snapshot",
    () => {
      const content = readCommittedContent(pathname, prepared, inspectImage, retain?.accept);
      const current = readStableSqliteFileGeneration(pathname, readGeneration);
      const after = readWalIndexHeader(pathname);
      verifyGenerationFamily(pathname, entries, current);
      if (
        !sameSqliteFileGeneration(generation, current) ||
        (before === null ? after !== null : !after?.equals(before)) ||
        (generation.wal && generation.wal.size > 0n && after?.[12] !== 1)
      ) {
        throw new Error(`SQLite WAL commit publication could not be verified: ${pathname}`);
      }
      const identity = [
        generation.database.dev.toString(),
        generation.database.ino.toString(),
        readDatabaseIdentityBirthtime(entry),
        content.sha256,
      ];
      const change = after?.subarray(8, 12).toString("hex") ?? null;
      const checksum = after?.subarray(24, 32).toString("hex") ?? null;
      // Checkpoints, including TRUNCATE, preserve iChange and the last commit
      // checksum. Keep that write evidence in the shipped fingerprint.
      const fingerprint = (writeChange: string | null, writeChecksum: string | null) =>
        sha256Hex(JSON.stringify([...identity, writeChange, writeChecksum]));
      const emptyReader =
        !generation.journal &&
        (generation.wal?.size ?? 0n) === 0n &&
        (after === null || (change === "00000000" && checksum === "0000000000000000"));
      let preparedSource: PreparedSqliteSnapshotSource | undefined;
      if (content.family) {
        const family = captureSqlitePrivateSnapshotFamily(
          prepared.location,
          prepared.cleanupRoot ?? path.dirname(prepared.location),
        );
        if (family?.main !== content.family.main || family?.wal !== content.family.wal) {
          throw new Error("Database generation private image changed before retention");
        }
        preparedSource = { sourcePath: pathname, prepared, family: content.family };
        retained = true;
      }
      return {
        generation: fingerprint(change, checksum),
        physical: serializePhysicalGeneration(current, after),
        // The first read-only native open can create this zero-write WAL index;
        // closing the last writer can remove it. Neither changes committed content.
        ...(emptyReader
          ? {
              emptyReaderAlternate:
                after === null
                  ? fingerprint("00000000", "0000000000000000")
                  : fingerprint(null, null),
            }
          : {}),
        ...(preparedSource ? { preparedSource } : {}),
      };
    },
  );
}

/** Run only in an isolated process, after all source handles drain, or under a
 * schema-maintenance owner before live reads are admitted: raw close
 * can release this process's SQLite locks. Inspect only the supplied inventory. */
export function readUpdateDatabaseGenerations(
  paths: readonly string[],
  inspectImage?: (imagePath: string, sourcePath: string) => void,
): UpdateDatabaseGenerations {
  return readUpdateDatabaseGenerationPair(paths, inspectImage).committed;
}

/** Both wire formats come from the same verified family observation. */
export function readUpdateDatabaseGenerationPair(
  paths: readonly string[],
  inspectImage?: (imagePath: string, sourcePath: string) => void,
): UpdateDatabaseGenerationPair {
  const committed: UpdateDatabaseGenerations = {};
  const physical: UpdateDatabaseGenerations = {};
  const emptyReaderAlternates: Record<string, string> = {};
  for (const pathname of paths) {
    const observation = readUpdateDatabaseGeneration(pathname, inspectImage);
    committed[pathname] = observation.generation;
    physical[pathname] = observation.physical;
    if (observation.emptyReaderAlternate) {
      emptyReaderAlternates[pathname] = observation.emptyReaderAlternate;
    }
  }
  return { committed, physical, emptyReaderAlternates };
}

/** Same raw-close restrictions as readUpdateDatabaseGenerations; never under native exclusion. */
export function readMatchingUpdateDatabaseGeneration(
  pathname: string,
  expected: string,
): string | undefined {
  const observed = readUpdateDatabaseGeneration(pathname);
  return observed.generation === expected || observed.emptyReaderAlternate === expected
    ? (observed.generation ?? undefined)
    : undefined;
}
