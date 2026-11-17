import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { isHardlinkFallbackError } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { tryInspectSqliteReadOnlyInProcess } from "./sqlite-readonly-inspection.js";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationInProcess } from "./sqlite-readonly-location.js";
import type { StateDatabaseDiscovery } from "./update-candidate-paths.js";
import { updateStateDatabaseExists } from "./update-candidate-state.sizes.js";

// Production callers run in update-candidate-state.worker.ts's inventory/snapshot
// subprocess modes. Direct in-process calls are confined to test fixtures.
function readColdArchiveNames(database: DatabaseSync): string[] {
  if (!tableExists(database, "session_transcript_cold_archives")) {
    return [];
  }
  const db = getNodeSqliteKysely<DB>(database);
  let query = db
    .selectFrom("session_transcript_cold_archives as archive")
    .select("archive.archive_name")
    .where("archive.storage", "=", "file");
  if (tableExists(database, "session_transcript_cold_archive_chunks")) {
    query = query
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("session_transcript_cold_archive_chunks as chunk")
              .select("chunk.session_id")
              .whereRef("chunk.session_id", "=", "archive.session_id"),
          ),
        ),
      )
      .unionAll(
        db
          .selectFrom("session_transcript_cold_archive_chunks as chunk")
          .innerJoin(
            "session_transcript_cold_archives as archive",
            "archive.session_id",
            "chunk.session_id",
          )
          .select("chunk.archive_name")
          .where("archive.storage", "=", "file"),
      );
  }
  return [...new Set(executeSqliteQuerySync(database, query).rows.map((row) => row.archive_name))];
}

/**
 * Budget a full copy fallback using metadata only, in the isolated inventory subprocess.
 * Referenced payloads already missing from live state become a warning, not a refusal.
 */
export async function measureColdArchiveBytes(
  databases: ReadonlyMap<string, StateDatabaseDiscovery>,
  stagingRoot: string,
): Promise<{ bytes: number; warnings: string[] }> {
  const measured = new Set<string>();
  const missing: string[] = [];
  let bytes = 0;
  for (const { spellings } of databases.values()) {
    const file = spellings[0];
    if (!(await updateStateDatabaseExists(file))) {
      continue;
    }
    // Preserve incomplete WAL families; opening them directly creates source sidecars.
    let names = tryInspectSqliteReadOnlyInProcess(file, readColdArchiveNames)?.value;
    if (!names) {
      const prepared = await prepareSqliteReadOnlyLocationInProcess(file, stagingRoot);
      names = await withPreparedSqliteSnapshot(
        prepared,
        (location) => {
          using database = openNodeSqliteDatabase(location, { readOnly: true });
          return readColdArchiveNames(database);
        },
        { cleanupFailure: "warn" },
      );
    }
    for (const name of names) {
      const payload = resolveSessionColdArchivePath(file, name);
      if (measured.has(payload)) {
        continue;
      }
      measured.add(payload);
      try {
        bytes += (await fs.stat(payload)).size;
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        missing.push(payload);
      }
    }
  }
  const warnings = missing.length
    ? [
        `${missing.length} referenced cold transcript archive file(s) are missing (first: ${missing[0]}); the update rehearsal keeps them missing, so only a repair that reads them fails.`,
      ]
    : [];
  return { bytes, warnings };
}

/**
 * Mirror the copied rows' file storage without decoding or changing their payloads.
 * A payload missing from live state stays missing, so only a step that reads it fails.
 */
export async function copyColdArchives(
  database: DatabaseSync,
  sourceStorePath: string,
  targetStorePath: string,
): Promise<void> {
  for (const name of readColdArchiveNames(database)) {
    const source = resolveSessionColdArchivePath(sourceStorePath, name);
    const target = resolveSessionColdArchivePath(targetStorePath, name);
    let regularFile: boolean;
    try {
      regularFile = (await fs.lstat(source)).isFile();
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // Cold publication never overwrites an existing file; reset only unlinks it.
    // Do not chmod a shared inode. Symlinks instead get an independent file copy.
    // Windows always copies: unlinking a hard link where POSIX delete is unavailable
    // (for example an SMB share) clears the shared file's read-only attribute.
    if (process.platform !== "win32" && regularFile) {
      try {
        await fs.link(source, target);
        continue;
      } catch (error) {
        if (!isHardlinkFallbackError(error)) {
          throw error;
        }
      }
    }
    await fs.copyFile(source, target, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
  }
}
