import fs from "node:fs";
import { sha256Hex } from "./crypto-digest.js";
import { readBackupEngineImage, type BackupEngine } from "./database-engine/physical-store.js";
import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";
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
};

function readCommittedContent(
  pathname: string,
  generation: SqliteFileGeneration,
): { sha256: string; engine: BackupEngine["engine"] } {
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
    const { engine } = readBackupEngineImage(prepared.location, pathname);
    const content = prepared.journalFreeContent;
    if (content) {
      assertPublishedFileIdentitySync(prepared.location, content.identity, content);
      return { sha256: content.sha256, engine };
    }
    const descriptor = fs.openSync(prepared.location, "r");
    return runWithSqliteCleanup(
      { release: () => fs.closeSync(descriptor) },
      "Database generation digest",
      () => ({ sha256: hashFileDescriptorSync(descriptor).sha256, engine }),
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

/** Run only in an isolated process, after all source handles drain, or under a
 * schema-maintenance owner before live reads are admitted: raw close
 * can release this process's SQLite locks. Inspect only the supplied inventory. */
function readUpdateDatabaseGenerations(paths: readonly string[]) {
  const postgres: string[] = [];
  const generations: UpdateDatabaseGenerations = Object.fromEntries(
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
      // Acquisition binds this provisional observation; the final stable read
      // below verifies the whole family before its generation can be published.
      const generation = readSqliteFileGeneration(pathname);
      const content = readCommittedContent(pathname, generation);
      const current = readStableSqliteFileGeneration(pathname);
      const after = readWalIndexHeader(pathname);
      if (
        !sameSqliteFileGeneration(generation, current) ||
        (before === null ? after !== null : !after?.equals(before)) ||
        (generation.wal && generation.wal.size > 0n && after?.[12] !== 1)
      ) {
        throw new Error(`SQLite WAL commit publication could not be verified: ${pathname}`);
      }
      // Classify the same verified image; reacquiring the live family here would
      // repeat a full snapshot and could observe a different engine generation.
      if (content.engine === "postgres") {
        postgres.push(pathname);
      }
      // Checkpoints preserve iChange and the last committed frame checksum,
      // including TRUNCATE, which resets frame count and salts. Rebuilding the
      // WAL index does not: the first native open of a family with no holder
      // recovers -shm and resets iChange. Callers that must compare generations
      // across a capture acquire sources without opening them natively.
      // A reversed write leaving identical bytes and write evidence is
      // indistinguishable from no write; restoring loses no later data.
      return [
        pathname,
        sha256Hex(
          JSON.stringify([
            generation.database.dev.toString(),
            generation.database.ino.toString(),
            readDatabaseIdentityBirthtime(entry),
            content.sha256,
            after?.subarray(8, 12).toString("hex") ?? null,
            after?.subarray(24, 32).toString("hex") ?? null,
          ]),
        ),
      ];
    }),
  );
  return { generations, postgres };
}

export async function readUpdatePhysicalDatabaseGenerations(
  paths: readonly string[],
  pluginOwners?: DatabasePortPluginOwners,
) {
  const { generations, postgres } = readUpdateDatabaseGenerations(paths);
  if (postgres.length) {
    const { fingerprintPostgresBackup } = await import("../snapshot/database-backup.js");
    const { createConfigIO } = await import("../config/io.js");
    const { config } = await createConfigIO({
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    for (const pathname of postgres) {
      generations[pathname] = await fingerprintPostgresBackup(pathname, config, pluginOwners);
    }
  }
  return generations;
}
