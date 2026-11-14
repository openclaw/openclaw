import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { readBackupEngineImage, type BackupEngine } from "./database-engine/physical-store.js";
import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteSnapshotSource } from "./sqlite-readonly-location.types.js";
import {
  readUpdateDatabaseGeneration,
  readUpdateDatabaseGenerationPair,
  type SqliteDatabaseGenerationReceipt,
} from "./update-database-generations.js";

export function readUpdatePhysicalDatabaseObservation(
  pathname: string,
  stagingRoot?: string,
): {
  engine?: BackupEngine;
  generation: Result<string | null, unknown>;
  preparedSource?: PreparedSqliteSnapshotSource;
  sqliteReceipt?: SqliteDatabaseGenerationReceipt;
} {
  let engine: BackupEngine | undefined;
  let classificationFailed = false;
  try {
    const observation = readUpdateDatabaseGeneration(
      pathname,
      (imagePath, sourcePath) => {
        try {
          engine = readBackupEngineImage(imagePath, sourcePath);
        } catch (error) {
          classificationFailed = true;
          throw error;
        }
      },
      stagingRoot ? { stagingRoot, accept: () => engine?.engine === "sqlite" } : undefined,
    );
    return {
      engine,
      generation: ok(observation.generation),
      preparedSource: observation.preparedSource,
      ...(engine?.engine === "sqlite" && observation.generation && observation.physical
        ? {
            sqliteReceipt: Object.freeze({
              sourcePath: pathname,
              generation: observation.generation,
              physical: observation.physical,
            }),
          }
        : {}),
    };
  } catch (error) {
    if (
      classificationFailed ||
      collectNestedErrorCandidates(error).some(
        (failure) => failure instanceof SqliteSnapshotCleanupError,
      )
    ) {
      throw error;
    }
    // The coherent private image already established the engine. A later generation
    // failure removes rollback authority, but does not require another engine image.
    return { engine, generation: err(error) };
  }
}

export async function readUpdatePostgresDatabaseGenerations(
  paths: readonly string[],
  pluginOwners?: DatabasePortPluginOwners,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (paths.length) {
    const { fingerprintPostgresBackup } = await import("../snapshot/database-backup.js");
    const { createConfigIO } = await import("../config/io.js");
    const { config } = await createConfigIO({
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    for (const pathname of paths) {
      result[pathname] = await fingerprintPostgresBackup(pathname, config, pluginOwners);
    }
  }
  return result;
}

export async function readUpdatePhysicalDatabaseGenerations(
  paths: readonly string[],
  pluginOwners?: DatabasePortPluginOwners,
) {
  const result: Record<string, string | null> = {};
  const postgres: string[] = [];
  for (const pathname of paths) {
    const observation = readUpdatePhysicalDatabaseObservation(pathname);
    if (!observation.generation.ok) {
      throw observation.generation.error;
    }
    result[pathname] = observation.generation.value;
    if (observation.engine?.engine === "postgres") {
      postgres.push(pathname);
    }
  }
  return Object.assign(result, await readUpdatePostgresDatabaseGenerations(postgres, pluginOwners));
}

export async function readUpdatePhysicalDatabaseGenerationPair(
  paths: readonly string[],
  pluginOwners?: DatabasePortPluginOwners,
) {
  const postgres: string[] = [];
  // Classify the captured image without reacquiring the live source family.
  const result = readUpdateDatabaseGenerationPair(paths, (imagePath, sourcePath) => {
    if (readBackupEngineImage(imagePath, sourcePath).engine === "postgres") {
      postgres.push(sourcePath);
    }
  });
  const fingerprints = await readUpdatePostgresDatabaseGenerations(postgres, pluginOwners);
  Object.assign(result.committed, fingerprints);
  Object.assign(result.physical, fingerprints);
  return result;
}

/** Only the recorded 9.33-line parent sends an unmarked restore inspection. */
export async function isLegacyUpdateGenerationRequest(env: NodeJS.ProcessEnv): Promise<boolean> {
  const { findActiveUpdateRun } = await import("./update-run-reader.js");
  const { readUpdateRunDriver, sameUpdateRunDriver } = await import("./update-run-driver.js");
  const run = findActiveUpdateRun({ env });
  if (run?.status !== "running" || !["2026.9.33", "2026.9.34"].includes(run.before.version ?? "")) {
    return false;
  }
  const parent = readUpdateRunDriver(process.ppid);
  return (
    parent !== undefined &&
    [run.origin.driver, ...(run.origin.previousDrivers ?? [])].some(
      (driver) => driver && sameUpdateRunDriver(driver, parent),
    )
  );
}
