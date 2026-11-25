import fs from "node:fs/promises";
import path from "node:path";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { hasNodeErrorCode } from "./path-guards.js";
import type { measureUpdateStateFiles } from "./update-candidate-io.js";
import { UpdateCaptureSpaceError } from "./update-capture-space.js";

const RESERVE_BYTES = 64 * 1024 * 1024;

type MeasuredFamilies = Awaited<ReturnType<typeof measureUpdateStateFiles>>;

async function readDevice(directory: string): Promise<bigint> {
  // Preflight runs before the backup directory exists; identify its existing ancestor.
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      return (await fs.stat(current, { bigint: true })).dev;
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT") || path.dirname(current) === current) {
        throw error;
      }
    }
  }
}

/**
 * What a pre-migration image writes, and what the migration itself needs.
 *
 * The image reads each family through SQLite into private staging and then
 * publishes it, so it writes every family once plus one family of staging.
 * Restore checks its own writable output before it moves a live database
 * (`update-database-restore.ts`), so capture reserves nothing for it.
 */
async function planUpdateDatabaseSpace(directory: string, { families }: MeasuredFamilies) {
  const backupDevice = await readDevice(directory);
  let imageBytes = 0;
  let largest = 0;
  const migration = new Map<bigint | string, { directory: string; bytes: number }>();
  for (const family of families) {
    if (family.bytes === 0) {
      continue;
    }
    imageBytes += family.bytes;
    largest = Math.max(largest, family.bytes);
    const sourceDirectory = path.dirname(family.path);
    const device = await readDevice(sourceDirectory);
    // A schema migration is one SQLite transaction per database. Its WAL holds
    // each rewritten page once, up to about the database's size (measured: 685 MB
    // of WAL for a v36 to v40 shared database of about 0.7 GB), then is truncated.
    const key = device > 0n ? device : sourceDirectory;
    const volume = migration.get(key);
    if (!volume || family.bytes > volume.bytes) {
      // Name the largest database's directory; that is where its WAL grows.
      migration.set(key, { directory: sourceDirectory, bytes: family.bytes });
    }
  }
  const volumes = [...migration].map(([device, volume]) => ({
    directory: volume.directory,
    sameVolumeAsImage: device === backupDevice,
    requiredBytes: volume.bytes + RESERVE_BYTES,
  }));
  // The retained image lives through both phases: capture adds one family of
  // staging, then the migration on a shared volume needs its own room. They do
  // not overlap, so the image needs room for the larger of the two.
  const headroom = volumes
    .filter((volume) => volume.sameVolumeAsImage)
    .reduce((most, volume) => Math.max(most, volume.requiredBytes), RESERVE_BYTES);
  return {
    imageRequiredBytes: imageBytes === 0 ? 0 : imageBytes + Math.max(largest, headroom),
    migrationVolumes: volumes,
  };
}

function describeSpace(label: string, directory: string, requiredBytes: number) {
  const space = tryReadDiskSpace(directory);
  return {
    space,
    diagnostic: `${label} near ${directory}: ${formatDiskSpaceBytes(requiredBytes)} (${requiredBytes} bytes) needed; ${space ? `${formatDiskSpaceBytes(space.availableBytes)} (${space.availableBytes} bytes) free` : "free space unknown"}.`,
  };
}

/** Capture admission. Throws when the image does not fit; the update skips it. */
export async function checkUpdateDatabaseBackupSpace(
  directory: string,
  measured: MeasuredFamilies,
) {
  const { imageRequiredBytes: requiredBytes } = await planUpdateDatabaseSpace(directory, measured);
  const { space, diagnostic } = describeSpace(
    "Pre-migration database image",
    directory,
    requiredBytes,
  );
  if (space && space.availableBytes < requiredBytes) {
    throw new UpdateCaptureSpaceError(
      `The pre-migration database image needs ${formatDiskSpaceBytes(requiredBytes)} (${requiredBytes} bytes) near ${directory}, but only ${formatDiskSpaceBytes(space.availableBytes)} (${space.availableBytes} bytes) is available. Free disk space before retrying; the databases have not been migrated.`,
      { requiredBytes, availableBytes: space.availableBytes, volume: "backup" },
    );
  }
  return {
    diagnostics: [diagnostic],
    warnings: space
      ? []
      : [
          `Available disk space could not be measured near ${directory}; the pre-migration database image will be attempted.`,
        ],
  };
}

/**
 * Preflight, before anything changes. The only refusal is no room for the
 * migration itself; an image that does not fit is reported as skipped.
 */
export async function assessUpdateDatabaseSpace(directory: string, measured: MeasuredFamilies) {
  const plan = await planUpdateDatabaseSpace(directory, measured);
  const diagnostics: string[] = [];
  const warnings: string[] = [];
  let refusal: string | undefined;
  for (const volume of plan.migrationVolumes) {
    const { space, diagnostic } = describeSpace(
      "Database migration room",
      volume.directory,
      volume.requiredBytes,
    );
    diagnostics.push(diagnostic);
    if (space && space.availableBytes < volume.requiredBytes) {
      refusal ??= `A database migration may need up to ${formatDiskSpaceBytes(volume.requiredBytes)} (${volume.requiredBytes} bytes) of free space near ${volume.directory} for its write-ahead log, but only ${formatDiskSpaceBytes(space.availableBytes)} (${space.availableBytes} bytes) is available. Free at least ${formatDiskSpaceBytes(volume.requiredBytes - space.availableBytes)} (${volume.requiredBytes - space.availableBytes} bytes) on that volume, then run openclaw update again; nothing has changed.`;
    }
  }
  let imageSkipped = false;
  if (plan.imageRequiredBytes > 0) {
    const { space, diagnostic } = describeSpace(
      "Pre-migration database image",
      directory,
      plan.imageRequiredBytes,
    );
    diagnostics.push(diagnostic);
    if (space && space.availableBytes < plan.imageRequiredBytes) {
      imageSkipped = true;
      warnings.push(
        `${formatUpdateDatabaseImageSkip(plan.imageRequiredBytes, space.availableBytes, directory)} The update continues and measures the image again before the migration.`,
      );
    } else if (!space) {
      warnings.push(
        `Available disk space could not be measured near ${directory}; the pre-migration database image will be attempted.`,
      );
    }
  }
  return { refusal, imageSkipped, warnings, diagnostics };
}

/** Names what is skipped and the recovery it gives up. */
export function formatUpdateDatabaseImageSkip(
  requiredBytes: number,
  availableBytes: number,
  directory: string,
): string {
  return `No pre-migration database image: it needs ${formatDiskSpaceBytes(requiredBytes)} near ${directory} and ${formatDiskSpaceBytes(availableBytes)} is free. Without it, the previous version cannot be restored once the new version's database migration commits; a failed update then stays on the new version and is fixed forward.`;
}
