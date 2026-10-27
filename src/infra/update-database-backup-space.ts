import fs from "node:fs/promises";
import path from "node:path";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { hasNodeErrorCode } from "./path-guards.js";
import type { measureUpdateStateFiles } from "./update-candidate-io.js";
import { UpdateCaptureSpaceError } from "./update-capture-space.js";

/** Shared admission for initial preflight and the activation-time capture. */
export async function checkUpdateDatabaseBackupSpace(
  directory: string,
  { bytes, largest, families }: Awaited<ReturnType<typeof measureUpdateStateFiles>>,
) {
  const warnings: string[] = [];
  const diagnostics: string[] = [];
  const check = (target: string, requiredBytes: number, purpose: string) => {
    const space = tryReadDiskSpace(target);
    diagnostics.push(
      `${purpose} near ${target}: ${formatDiskSpaceBytes(requiredBytes)} (${requiredBytes} bytes) needed; ${space ? `${formatDiskSpaceBytes(space.availableBytes)} (${space.availableBytes} bytes) free` : "free space unknown"}.`,
    );
    if (space && space.availableBytes < requiredBytes) {
      throw new UpdateCaptureSpaceError(
        `${purpose} needs ${formatDiskSpaceBytes(requiredBytes)} (${requiredBytes} bytes) near ${target}, but only ${formatDiskSpaceBytes(space.availableBytes)} (${space.availableBytes} bytes) is available. Free disk space before retrying; the databases have not been migrated.`,
        { requiredBytes, availableBytes: space.availableBytes },
      );
    }
    if (!space) {
      warnings.push(
        `Available disk space could not be measured near ${target}; database backup will be attempted.`,
      );
    }
  };
  const reserve = 64 * 1024 * 1024;
  // This volume holds snapshots, same-volume rollback copies, and acquisition/publication scratch.
  check(directory, bytes === 0 ? 0 : 2 * bytes + 3 * largest + reserve, "Update database backup");
  // Preflight runs before the backup directory exists; inspect its existing ancestor.
  let ancestor = directory;
  let backupDevice: bigint;
  for (;;) {
    try {
      backupDevice = (await fs.stat(ancestor, { bigint: true })).dev;
      break;
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT") || path.dirname(ancestor) === ancestor) {
        throw error;
      }
      ancestor = path.dirname(ancestor);
    }
  }
  const sources = new Map<bigint | string, { directory: string; bytes: number; largest: number }>();
  for (const family of families) {
    if (family.bytes === 0) {
      continue;
    }
    const sourceDirectory = path.dirname(family.path);
    const device = (await fs.stat(sourceDirectory, { bigint: true })).dev;
    if (device > 0n && device === backupDevice) {
      continue;
    }
    // Unknown identity cannot prove that the backup volume's allowance covers this destination.
    const key = device > 0n ? device : sourceDirectory;
    let source = sources.get(key);
    if (!source) {
      source = { directory: sourceDirectory, bytes: 0, largest: 0 };
      sources.set(key, source);
      if (device === 0n) {
        warnings.push(
          `Filesystem identity is unavailable near ${sourceDirectory}; restore space is checked separately.`,
        );
      }
    }
    source.bytes += family.bytes;
    source.largest = Math.max(source.largest, family.bytes);
  }
  for (const source of sources.values()) {
    // Migrated files remain in place during rollback: reserve S + largest publication scratch + headroom.
    check(source.directory, source.bytes + source.largest + reserve, "Update database rollback");
  }
  return { warnings, diagnostics };
}
