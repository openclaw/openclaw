import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { tryInspectSqliteReadOnlyInProcess } from "./sqlite-readonly-inspection.js";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationInProcess } from "./sqlite-readonly-location.js";
import type { StateDatabaseDiscovery } from "./update-candidate-paths.js";
import { updateStateDatabaseExists } from "./update-candidate-state.sizes.js";

function readColdArchiveNames(database: DatabaseSync): string[] {
  if (!tableExists(database, "session_transcript_cold_archives")) {
    return [];
  }
  const db = getNodeSqliteKysely<Pick<DB, "session_transcript_cold_archives">>(database);
  const { rows } = executeSqliteQuerySync(
    database,
    db
      .selectFrom("session_transcript_cold_archives")
      .select("archive_name")
      .where("storage", "=", "file")
      .distinct(),
  );
  return rows.map((row) => row.archive_name);
}

/** Budget independent payload copies in the isolated inventory process. */
export async function measureColdArchiveBytes(
  databases: ReadonlyMap<string, StateDatabaseDiscovery>,
  stagingRoot: string,
): Promise<number> {
  const measured = new Set<string>();
  let bytes = 0;
  for (const { spellings } of databases.values()) {
    const file = spellings[0];
    if (!(await updateStateDatabaseExists(file))) {
      continue;
    }
    // Never create WAL sidecars in a source that must be copied for inspection.
    const names =
      tryInspectSqliteReadOnlyInProcess(file, readColdArchiveNames)?.value ??
      (await withPreparedSqliteSnapshot(
        await prepareSqliteReadOnlyLocationInProcess(file, stagingRoot),
        (location) => {
          using database = openNodeSqliteDatabase(location, { readOnly: true });
          return readColdArchiveNames(database);
        },
        { cleanupFailure: "warn" },
      ));
    for (const name of names) {
      const payload = resolveSessionColdArchivePath(file, name);
      if (!measured.has(payload)) {
        bytes += (await fs.stat(payload)).size;
        measured.add(payload);
      }
    }
  }
  return bytes;
}

/** Preserve the copied row's storage and do not mutate or borrow live archive ownership. */
export async function copyColdArchives(
  database: DatabaseSync,
  sourceStorePath: string,
  targetStorePath: string,
): Promise<void> {
  for (const name of readColdArchiveNames(database)) {
    const source = resolveSessionColdArchivePath(sourceStorePath, name);
    const target = resolveSessionColdArchivePath(targetStorePath, name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // An independent copy also avoids Windows cleanup changing a shared inode's attributes.
    await fs.copyFile(source, target, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
  }
}
