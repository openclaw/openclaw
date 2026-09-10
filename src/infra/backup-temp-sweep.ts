// Reclaims only marked backup staging whose owner stopped refreshing it.
import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "./fs-safe-advanced.js";

const BACKUP_TEMP_ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;
const BACKUP_TEMP_KEEPALIVE_INTERVAL_MS = BACKUP_TEMP_ORPHAN_MIN_AGE_MS / 48;
// Unmarked directories may belong to a live pre-upgrade backup.
const OWNER_MARKER_FILENAME = ".openclaw-backup-owner";

function hasBackupTempIdentity(identity: Stats): boolean {
  return process.platform !== "win32" || (identity.dev !== 0 && identity.ino !== 0);
}

export function sameBackupTempIdentity(left: Stats, right: Stats): boolean {
  // The general read comparator tolerates unknown Windows IDs; mutation cannot.
  return (
    hasBackupTempIdentity(left) && hasBackupTempIdentity(right) && sameFileIdentity(left, right)
  );
}

function readIdentity(filePath: string): Stats | undefined {
  try {
    return fsSync.lstatSync(filePath);
  } catch {
    return undefined;
  }
}

function isOwnedDirectory(directoryPath: string, identity: Stats): boolean {
  const current = readIdentity(directoryPath);
  return Boolean(current?.isDirectory() && sameBackupTempIdentity(identity, current));
}

function isPrivateMarker(identity: Stats): boolean {
  return (
    identity.isFile() &&
    identity.nlink === 1 &&
    (process.platform === "win32" || (identity.mode & 0o077) === 0)
  );
}

export function keepBackupTempDirectoryAlive(
  directoryPath: string,
  expectedIdentity: Stats,
): () => boolean {
  if (!isOwnedDirectory(directoryPath, expectedIdentity)) {
    throw new Error(`Backup staging directory changed before ownership: ${directoryPath}`);
  }
  const markerPath = path.join(directoryPath, OWNER_MARKER_FILENAME);
  const descriptor = fsSync.openSync(markerPath, "wx", 0o600);
  let markerIdentity: Stats;
  try {
    markerIdentity = fsSync.fstatSync(descriptor);
  } catch (error) {
    try {
      fsSync.closeSync(descriptor);
    } catch {
      // Preserve the original identity-read failure.
    }
    throw error;
  }
  try {
    fsSync.closeSync(descriptor);
  } catch (error) {
    if (isOwnedDirectory(directoryPath, expectedIdentity)) {
      const marker = readIdentity(markerPath);
      if (marker?.isFile() && sameBackupTempIdentity(markerIdentity, marker)) {
        try {
          fsSync.unlinkSync(markerPath);
        } catch {
          // Preserve the setup failure when marker cleanup also fails.
        }
      }
    }
    throw error;
  }
  if (!hasBackupTempIdentity(markerIdentity)) {
    throw new Error(`Backup staging marker identity is unavailable: ${markerPath}`);
  }
  const ownsMarker = (): boolean => {
    if (!isOwnedDirectory(directoryPath, expectedIdentity)) {
      return false;
    }
    const marker = readIdentity(markerPath);
    return Boolean(
      marker && isPrivateMarker(marker) && sameBackupTempIdentity(markerIdentity, marker),
    );
  };
  const timer = setInterval(() => {
    // Keep checks and update together: a queued refresh must not touch a replacement.
    if (ownsMarker()) {
      try {
        const now = new Date();
        fsSync.utimesSync(directoryPath, now, now);
      } catch {
        // A failed refresh supplies no evidence of activity to the next sweep.
      }
    }
  }, BACKUP_TEMP_KEEPALIVE_INTERVAL_MS);
  timer.unref();
  let markerRemoved = false;
  return () => {
    clearInterval(timer);
    if (!isOwnedDirectory(directoryPath, expectedIdentity)) {
      return false;
    }
    if (markerRemoved) {
      try {
        return fsSync.lstatSync(markerPath, { throwIfNoEntry: false }) === undefined;
      } catch {
        return false;
      }
    }
    if (!ownsMarker()) {
      return false;
    }
    try {
      fsSync.unlinkSync(markerPath);
      markerRemoved = true;
      return true;
    } catch {
      return false;
    }
  };
}

function removeStaleDirectory(directoryPath: string, nowMs: number): boolean {
  try {
    const directory = fsSync.lstatSync(directoryPath);
    if (!directory.isDirectory()) {
      return false;
    }
    const markerPath = path.join(directoryPath, OWNER_MARKER_FILENAME);
    const marker = fsSync.lstatSync(markerPath);
    if (!isPrivateMarker(marker)) {
      return false;
    }
    let newestMs = Math.max(directory.mtimeMs, marker.mtimeMs);
    for (const name of fsSync.readdirSync(directoryPath)) {
      const child = fsSync.lstatSync(path.join(directoryPath, name));
      if (child.isSymbolicLink()) {
        return false;
      }
      newestMs = Math.max(newestMs, child.mtimeMs);
    }
    const currentDirectory = fsSync.lstatSync(directoryPath);
    const currentMarker = fsSync.lstatSync(markerPath);
    if (
      !currentDirectory.isDirectory() ||
      !sameBackupTempIdentity(directory, currentDirectory) ||
      !isPrivateMarker(currentMarker) ||
      !sameBackupTempIdentity(marker, currentMarker) ||
      nowMs - Math.max(newestMs, currentDirectory.mtimeMs, currentMarker.mtimeMs) <
        BACKUP_TEMP_ORPHAN_MIN_AGE_MS
    ) {
      return false;
    }
    // No awaited work separates inspection from removal. This is a cooperative
    // same-user fence, not isolation from hostile concurrent filesystem mutation.
    fsSync.rmSync(directoryPath, { recursive: true });
    return true;
  } catch {
    // Missing, changed or unreadable staging is not proved abandoned.
    return false;
  }
}

export async function sweepStaleBackupTempDirectories(params: {
  directoryPath: string;
  entryPattern: RegExp;
  log?: (message: string) => void;
}): Promise<void> {
  const entries = await fs.readdir(params.directoryPath).catch(() => undefined);
  if (!entries) {
    return;
  }
  const nowMs = Date.now();
  for (const name of entries) {
    if (!params.entryPattern.test(name)) {
      continue;
    }
    const entryPath = path.join(params.directoryPath, name);
    if (removeStaleDirectory(entryPath, nowMs)) {
      params.log?.(`Backup removed stale temp directory ${entryPath}.`);
    }
  }
}
