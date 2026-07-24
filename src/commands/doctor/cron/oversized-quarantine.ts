import { randomBytes } from "node:crypto";
// Doctor migration for cron quarantine sidecars that exceed the bounded read cap.
import fs from "node:fs";
import { CRON_QUARANTINE_MAX_BYTES } from "../../../cron/store.js";
import { shortenHomePath } from "../../../utils.js";

/** Returns true when a regular quarantine sidecar exists and is above the cap. */
export function isOversizedCronQuarantineSidecar(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > CRON_QUARANTINE_MAX_BYTES;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * Moves an oversized quarantine sidecar to a timestamped archive path so the
 * runtime can start fresh without discarding the legacy artifact.
 */
export function archiveOversizedCronQuarantineSidecar(filePath: string): string {
  const timestamp = Date.now();
  const random = randomBytes(4).toString("hex");
  const archivePath = `${filePath}.oversized.${timestamp}.${random}.archive.json`;
  fs.renameSync(filePath, archivePath);
  return archivePath;
}

/** Human-readable note describing the archived sidecar. */
export function formatArchivedQuarantineNote(params: {
  archivePath: string;
  originalPath: string;
}): string {
  return `Archived oversized cron quarantine sidecar (${CRON_QUARANTINE_MAX_BYTES} bytes) from ${shortenHomePath(params.originalPath)} to ${shortenHomePath(params.archivePath)}.`;
}
