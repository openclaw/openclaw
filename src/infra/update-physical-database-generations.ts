import { readBackupEngineImage } from "./database-engine/physical-store.js";
import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";

export async function readUpdatePhysicalDatabaseGenerations(
  paths: readonly string[],
  pluginOwners?: DatabasePortPluginOwners,
) {
  const postgres: string[] = [];
  // Classify the captured image without reacquiring the live source family.
  const result = readUpdateDatabaseGenerations(paths, (imagePath, sourcePath) => {
    if (readBackupEngineImage(imagePath, sourcePath).engine === "postgres") {
      postgres.push(sourcePath);
    }
  });
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
