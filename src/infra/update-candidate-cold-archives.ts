import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

function readFileArchiveNames(target: string): string[] {
  using copy = openNodeSqliteDatabase(target, { readOnly: true });
  const tables = new Set(
    copy
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  if (!tables.has("session_transcript_cold_archives")) {
    return [];
  }
  const chunks = tables.has("session_transcript_cold_archive_chunks")
    ? ` UNION SELECT c.archive_name FROM session_transcript_cold_archive_chunks c
        JOIN session_transcript_cold_archives a USING (session_id) WHERE a.storage = 'file'`
    : "";
  return copy
    .prepare(
      `SELECT archive_name FROM session_transcript_cold_archives WHERE storage = 'file'${chunks}`,
    )
    .all()
    .map((row) => String(row.archive_name));
}

/**
 * Rehearsal Doctor resolves file-backed cold transcript archives beside its copied store, which
 * the SQLite snapshot does not carry. Hard-link each live archive there: no bytes, no privilege.
 * Every archive writer creates new names exclusively and renames or links them into place, reset
 * and cleanup only unlink, and nothing chmods or rewrites an archive, so a link never lets the
 * rehearsal change live bytes. Across volumes copy instead; if the rehearsal volume, which released
 * drivers size for SQLite files only, cannot hold the copy, a symbolic link still lets reads
 * verify the live payload. An archive that is absent live stays absent in the rehearsal.
 */
export async function linkRehearsalColdArchives(
  target: string,
  sourceStorePath: string,
): Promise<void> {
  for (const name of readFileArchiveNames(target)) {
    const live = resolveSessionColdArchivePath(sourceStorePath, name);
    const copy = resolveSessionColdArchivePath(target, name);
    await fs.mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
    await fs.link(live, copy).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EEXIST") {
        return;
      }
      await fs
        .copyFile(live, copy, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
        .catch(async () => {
          await fs.rm(copy, { force: true });
          await fs.symlink(live, copy);
        });
    });
  }
}
