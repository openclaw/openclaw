// Shared filesystem helpers for plugin doctor legacy-state migrations.
import fs from "node:fs/promises";
import { readRegularFile } from "../infra/fs-safe.js";

/** Bound the existing-archive byte comparison so a huge prior snapshot cannot
 * force an unbounded allocation during a later migration. */
const ARCHIVE_COMPARE_MAX_BYTES = 64 * 1024 * 1024;

/** True when the legacy-state path exists and is a regular file. */
export async function legacyStateFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Renames a migrated legacy source to `<path>.migrated`, recording the outcome in the
 * doctor changes/warnings lists. Never throws: a failed archive leaves the source in
 * place so a later doctor run can retry without losing migrated data.
 */
export async function archiveLegacyStateSource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  try {
    if (await legacyStateFileExists(archivedPath)) {
      // Import commits before archival, so an existing archive must converge
      // instead of re-warning every startup (#102749): identical bytes already
      // preserve the snapshot; differing bytes archive under a free suffix.
      const [sourceStat, archiveStat] = await Promise.all([
        fs.stat(params.filePath),
        fs.stat(archivedPath),
      ]);
      if (sourceStat.size === archiveStat.size && sourceStat.size <= ARCHIVE_COMPARE_MAX_BYTES) {
        const [sourceResult, archiveResult] = await Promise.all([
          readRegularFile({ filePath: params.filePath, maxBytes: ARCHIVE_COMPARE_MAX_BYTES }),
          readRegularFile({ filePath: archivedPath, maxBytes: ARCHIVE_COMPARE_MAX_BYTES }),
        ]);
        if (sourceResult.buffer.equals(archiveResult.buffer)) {
          await fs.rm(params.filePath, { force: true });
          params.changes.push(
            `Removed already-archived ${params.label} legacy source ${params.filePath}`,
          );
          return;
        }
      }
      const nextArchivePath = await firstFreeArchivePath(params.filePath);
      await fs.rename(params.filePath, nextArchivePath);
      params.changes.push(`Archived ${params.label} legacy source -> ${nextArchivePath}`);
      return;
    }
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} legacy source: ${String(err)}`);
  }
}

async function firstFreeArchivePath(sourcePath: string): Promise<string> {
  for (let index = 2; ; index++) {
    const candidate = `${sourcePath}.migrated.${index}`;
    if (!(await legacyStateFileExists(candidate))) {
      return candidate;
    }
  }
}
