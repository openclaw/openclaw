import fs from "node:fs";
import path from "node:path";

// Measured for openclaw 2026.11.3 (dist.unpackedSize 263 MiB): a fresh global install with its
// dependencies took 662 MiB (2.5x) and npm's cache 490 MiB (1.9x), so a stage needs about 4.4x.
const PACKAGE_UPDATE_STAGING_TENTHS = 44;

function finiteNonNegativeNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function findExistingDiskSpacePath(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      const stats = fs.statSync(current);
      return stats.isDirectory() ? current : path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

/** Reads available bytes for the volume containing a target path. */
export function tryReadDiskSpace(targetPath: string): {
  targetPath: string;
  checkedPath: string;
  availableBytes: number;
  totalBytes: number | null;
} | null {
  // Install/update targets may not exist yet; statfs needs the nearest existing
  // ancestor to identify the backing volume.
  const checkedPath = findExistingDiskSpacePath(targetPath);
  if (!checkedPath) {
    return null;
  }
  try {
    const stats = fs.statfsSync(checkedPath);
    const blockSize = finiteNonNegativeNumber(stats.bsize);
    const availableBlocks = finiteNonNegativeNumber(stats.bavail);
    if (blockSize === null || availableBlocks === null) {
      return null;
    }
    const totalBlocks = finiteNonNegativeNumber(stats.blocks);
    return {
      targetPath,
      checkedPath,
      availableBytes: blockSize * availableBlocks,
      totalBytes: totalBlocks === null ? null : blockSize * totalBlocks,
    };
  } catch {
    return null;
  }
}

/** Formats byte counts for compact operator-facing disk-space warnings. */
export function formatDiskSpaceBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  // Round before choosing the unit so a value that rounds up to 1024 MiB is
  // promoted to "1.0 GiB" instead of printing the impossible "1024 MiB".
  const roundedMib = Math.max(0, Math.round(mib));
  if (roundedMib < 1024) {
    return `${roundedMib} MiB`;
  }
  const gib = mib / 1024;
  return `${gib.toFixed(gib < 10 ? 1 : 0)} GiB`;
}

/** One refusal line when the install volume cannot hold a staged package update. */
export function describePackageStagingShortfall(
  targetPath: string,
  unpackedSize: number,
): string | null {
  const required = Math.ceil((unpackedSize * PACKAGE_UPDATE_STAGING_TENTHS) / 10);
  const snapshot = tryReadDiskSpace(targetPath);
  // Unmeasurable space is not a shortfall; the install's own ENOSPC handling still applies.
  if (!snapshot || snapshot.availableBytes >= required) {
    return null;
  }
  return `Update refused: ${formatDiskSpaceBytes(snapshot.availableBytes)} free on the volume holding ${snapshot.checkedPath}; this package update needs about ${formatDiskSpaceBytes(required)}. Free ${formatDiskSpaceBytes(required - snapshot.availableBytes)} there, then retry openclaw update. No changes were made.`;
}
