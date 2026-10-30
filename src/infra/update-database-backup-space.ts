import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { hasNodeErrorCode } from "./path-guards.js";
import type { measureUpdateStateFiles } from "./update-candidate-io.js";
import { UpdateCaptureSpaceError } from "./update-capture-space.js";

/** Shared admission for initial preflight and the activation-time capture. */
export async function checkUpdateDatabaseBackupSpace(
  directory: string,
  { bytes, largest, families }: Awaited<ReturnType<typeof measureUpdateStateFiles>>,
  context: { stateDir: string; config: OpenClawConfig },
) {
  const warnings: string[] = [];
  const diagnostics: string[] = [];
  const check = (target: string, requiredBytes: number, volume: "backup" | "rollback") => {
    const purpose = `Update database ${volume}`;
    const space = tryReadDiskSpace(target);
    diagnostics.push(
      `${purpose} near ${target}: ${formatDiskSpaceBytes(requiredBytes)} (${requiredBytes} bytes) needed; ${space ? `${formatDiskSpaceBytes(space.availableBytes)} (${space.availableBytes} bytes) free` : "free space unknown"}.`,
    );
    if (space && space.availableBytes < requiredBytes) {
      throw new UpdateCaptureSpaceError(
        `${purpose} needs ${formatDiskSpaceBytes(requiredBytes)} (${requiredBytes} bytes) near ${target}, but only ${formatDiskSpaceBytes(space.availableBytes)} (${space.availableBytes} bytes) is available. Free disk space before retrying; the databases have not been migrated.`,
        { requiredBytes, availableBytes: space.availableBytes, volume },
      );
    }
    if (!space) {
      warnings.push(
        `Available disk space could not be measured near ${target}; database backup will be attempted.`,
      );
    }
  };
  const reserve = 64 * 1024 * 1024;
  const sharedPath = resolvePathViaExistingAncestorSync(
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: context.stateDir }),
  );
  const sharedBytes = Object.values(resolveDatabaseFamilyEngines(context.config)).every(
    (engine) => engine === "sqlite",
  )
    ? families.find((family) => family.path === sharedPath)?.bytes
    : undefined;
  // Keep one backup S and independent writable rollback outputs S. Only shared
  // state H needs a current-history image and merge/journal scratch; a large
  // agent is never history scratch. Capture/publication fits within 2S and does
  // not overlap rollback preparation. Restore rechecks actual output space if
  // history grows after capture. Unknown/mixed ownership retains the old bound.
  const historyBytes = sharedBytes || largest;
  check(directory, bytes === 0 ? 0 : 2 * bytes + 3 * historyBytes + reserve, "backup");
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
    check(source.directory, source.bytes + source.largest + reserve, "rollback");
  }
  return { warnings, diagnostics };
}
