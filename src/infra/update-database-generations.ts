import fs from "node:fs";
import { sha256Hex } from "./crypto-digest.js";
import { ignoreMissingPath } from "./errno.js";
import { hashFileDescriptorSync } from "./file-descriptor.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readSqliteFileGeneration,
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "./sqlite-file-generation.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { assertPublishedFileIdentitySync } from "./sqlite-snapshot-file.js";
import { truncateSqliteWal } from "./sqlite-wal-checkpoint.js";
import {
  databaseFileIdentityKey,
  readDatabaseIdentityBirthtime,
} from "./sqlite-worker-identity.js";

export type UpdateDatabaseGenerations = Record<string, string | null>;
export type UpdateDatabaseWriteReceipt = {
  unchanged: boolean;
  fromGenerations?: UpdateDatabaseGenerations;
  generations: UpdateDatabaseGenerations;
  historicalScans?: import("./update-doctor-scan-receipts.js").UpdateDoctorHistoricalScans;
};

function readCommittedContent(
  pathname: string,
  generation: SqliteFileGeneration,
  inspectImage?: (imagePath: string, sourcePath: string) => void,
): string {
  // Checkpoint only a private copy: opening the source would compete with the
  // restore owner's native exclusion. SQLite owns WAL/journal interpretation.
  const prepared = prepareSqliteReadOnlyLocationSyncInProcess(
    pathname,
    undefined,
    {
      key: `file:${databaseFileIdentityKey(generation.database)}`,
    },
    !generation.journal && (generation.wal?.size ?? 0n) === 0n
      ? { sha256: generation.database.sha256, sizeBytes: Number(generation.database.size) }
      : undefined,
  );
  return runWithSqliteCleanup({ release: prepared.cleanup }, "Database generation snapshot", () => {
    const database = openNodeSqliteDatabase(prepared.location);
    runWithSqliteCleanup(
      { release: () => database.close() },
      "Database generation checkpoint",
      () => truncateSqliteWal(database, prepared.location),
    );
    // Native admission still rejects malformed catalogs. With no recovery data,
    // checkpointing leaves the digest-bound private image unchanged.
    inspectImage?.(prepared.location, pathname);
    const content = prepared.journalFreeContent;
    if (content) {
      assertPublishedFileIdentitySync(prepared.location, content.identity, content);
      return content.sha256;
    }
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
  emptyReaderAlternate?: string;
};

function readDatabaseGeneration(
  pathname: string,
  inspectImage?: (imagePath: string, sourcePath: string) => void,
): DatabaseGenerationObservation {
  const entry = fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
  if (!entry) {
    if (
      ["-wal", "-journal"].some((suffix) =>
        fs.lstatSync(`${pathname}${suffix}`, { throwIfNoEntry: false }),
      )
    ) {
      throw new Error(`Database is absent but retained journal data exists: ${pathname}`);
    }
    return { generation: null };
  }
  if (!entry.isFile()) {
    throw new Error(`Database generation requires a regular file: ${pathname}`);
  }
  const before = readWalIndexHeader(pathname);
  // Acquisition binds this provisional observation; the final stable read
  // below verifies the whole family before its generation can be published.
  const generation = readSqliteFileGeneration(pathname);
  const content = readCommittedContent(pathname, generation, inspectImage);
  const current = readStableSqliteFileGeneration(pathname);
  const after = readWalIndexHeader(pathname);
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
    content,
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
  return {
    generation: fingerprint(change, checksum),
    // The first read-only native open can create this zero-write WAL index;
    // closing the last writer can remove it. Neither changes committed content.
    ...(emptyReader
      ? {
          emptyReaderAlternate:
            after === null ? fingerprint("00000000", "0000000000000000") : fingerprint(null, null),
        }
      : {}),
  };
}

/** Run only in an isolated process, after all source handles drain, or under a
 * schema-maintenance owner before live reads are admitted: raw close
 * can release this process's SQLite locks. Inspect only the supplied inventory. */
export function readUpdateDatabaseGenerations(
  paths: readonly string[],
  inspectImage?: (imagePath: string, sourcePath: string) => void,
): UpdateDatabaseGenerations {
  return Object.fromEntries(
    paths.map((pathname) => [pathname, readDatabaseGeneration(pathname, inspectImage).generation]),
  );
}

/** Same raw-close restrictions as readUpdateDatabaseGenerations; never under native exclusion. */
export function readMatchingUpdateDatabaseGeneration(
  pathname: string,
  expected: string,
): string | undefined {
  const observed = readDatabaseGeneration(pathname);
  return observed.generation === expected || observed.emptyReaderAlternate === expected
    ? (observed.generation ?? undefined)
    : undefined;
}
