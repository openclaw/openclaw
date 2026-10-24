import { readBackupEngineImage } from "./database-engine/physical-store.js";
import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";

export async function readUpdatePhysicalDatabaseGenerations(
  paths: readonly string[],
  pluginOwners?: DatabasePortPluginOwners,
  legacyPhysical = false,
) {
  const postgres: string[] = [];
  // Classify the captured image without reacquiring the live source family.
  const result = readUpdateDatabaseGenerations(
    paths,
    (imagePath, sourcePath) => {
      if (readBackupEngineImage(imagePath, sourcePath).engine === "postgres") {
        postgres.push(sourcePath);
      }
    },
    legacyPhysical,
  );
  if (postgres.length) {
    const { fingerprintPostgresBackup } = await import("../snapshot/database-backup.js");
    const { createConfigIO } = await import("../config/io.js");
    const { config } = await createConfigIO({
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    for (const pathname of postgres) {
      result[pathname] = await fingerprintPostgresBackup(pathname, config, pluginOwners);
    }
  }
  return result;
}

/** Only unmarked requests from the shipped physical-digest producer need this adapter. */
export async function isLegacyUpdateGenerationRequest(env: NodeJS.ProcessEnv): Promise<boolean> {
  const { findActiveUpdateRun } = await import("./update-run-reader.js");
  const { readUpdateRunDriver, sameUpdateRunDriver } = await import("./update-run-driver.js");
  const run = findActiveUpdateRun({ env });
  if (run?.status !== "running" || run.before.version !== "2026.9.33") {
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
