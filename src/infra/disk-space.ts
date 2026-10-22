import fs from "node:fs";
import path from "node:path";

const LOW_DISK_SPACE_WARNING_THRESHOLD_BYTES = 1024 * 1024 * 1024;

type DiskSpaceSnapshot = {
  targetPath: string;
  checkedPath: string;
  availableBytes: number;
  totalBytes: number | null;
};

function finiteNonNegativeNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

/** Reads available bytes for the volume containing a target path. */
export function tryReadDiskSpace(targetPath: string): DiskSpaceSnapshot | null {
  // Install/update targets may not exist yet; statfs needs the nearest existing
  // ancestor to identify the backing volume.
  let checkedPath = path.resolve(targetPath);
  while (true) {
    try {
      const stats = fs.statSync(checkedPath);
      checkedPath = stats.isDirectory() ? checkedPath : path.dirname(checkedPath);
      break;
    } catch {
      const parent = path.dirname(checkedPath);
      if (parent === checkedPath) {
        return null;
      }
      checkedPath = parent;
    }
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

/** Builds a soft low-disk warning for setup/update flows without failing the operation. */
export function createLowDiskSpaceWarning(params: {
  targetPath: string;
  purpose: string;
}): string | null {
  const snapshot = tryReadDiskSpace(params.targetPath);
  if (!snapshot || snapshot.availableBytes >= LOW_DISK_SPACE_WARNING_THRESHOLD_BYTES) {
    return null;
  }
  const location =
    path.resolve(snapshot.targetPath) === path.resolve(snapshot.checkedPath)
      ? snapshot.checkedPath
      : `${snapshot.targetPath} (volume checked at ${snapshot.checkedPath})`;
  return `Low disk space near ${location}: ${formatDiskSpaceBytes(snapshot.availableBytes)} available; ${params.purpose} may fail.`;
}
