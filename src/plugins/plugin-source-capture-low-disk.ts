import { formatDiskSpaceBytes, tryReadDiskSpace } from "../infra/disk-space.js";

export class PluginSourceCaptureLowDiskError extends Error {
  constructor(
    readonly target: string,
    readonly freeBytes: number,
    readonly minFreeBytes: number,
  ) {
    super(
      `plugin source capture refused: only ${formatDiskSpaceBytes(freeBytes)} free on ${target} (floor ${formatDiskSpaceBytes(minFreeBytes)}). Free space on this volume, or set OPENCLAW_PLUGIN_CAPTURE_MIN_FREE_BYTES=0 to disable this floor, then retry the plugin load.`,
    );
    this.name = "PluginSourceCaptureLowDiskError";
  }
}

const DEFAULT_PLUGIN_SOURCE_CAPTURE_MIN_FREE_BYTES = 512 * 1024 * 1024;

export function resolvePluginSourceCaptureMinFreeBytes(): number {
  const raw = process.env.OPENCLAW_PLUGIN_CAPTURE_MIN_FREE_BYTES;
  if (raw !== undefined && raw.trim() !== "") {
    // Strict: a malformed override must never silently disable the guard.
    if (/^\d+$/.test(raw.trim())) {
      return Number.parseInt(raw.trim(), 10);
    }
    process.emitWarning(
      `OPENCLAW_PLUGIN_CAPTURE_MIN_FREE_BYTES must be a complete non-negative integer (bytes); ignoring ${JSON.stringify(raw)}`,
    );
  }
  return DEFAULT_PLUGIN_SOURCE_CAPTURE_MIN_FREE_BYTES;
}

/**
 * Refuses to stage new capture roots once the target volume drops below the
 * configured free-space floor. Without this guard, plugin load churn can stage
 * hundreds of megabytes per attempt and drive the volume into ENOSPC, which
 * fails the very loads that keep retrying (an amplification loop).
 *
 * Volume detection is delegated to the shared disk-space reader, which probes
 * the nearest existing ancestor (the same volume the directory would be created
 * on). If the volume cannot be inspected at all, the guard stays open: an
 * unknowable volume must not block loads on its own.
 */
export function assertPluginSourceCaptureDiskHeadroom(
  target: string,
  minFreeBytes = resolvePluginSourceCaptureMinFreeBytes(),
): void {
  if (minFreeBytes <= 0) {
    return;
  }
  const snapshot = tryReadDiskSpace(target);
  if (snapshot === null) {
    return;
  }
  if (snapshot.availableBytes < minFreeBytes) {
    throw new PluginSourceCaptureLowDiskError(
      snapshot.checkedPath,
      snapshot.availableBytes,
      minFreeBytes,
    );
  }
}
