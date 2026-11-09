import { readUpdateDatabaseGenerations } from "./update-database-generations.js";

// Physical backup inspection may load engine configuration; SQLite observation
// workers import only the dependency-light generation owner.
export async function readUpdatePhysicalDatabaseGenerations(paths: readonly string[]) {
  const result = readUpdateDatabaseGenerations(paths);
  const { readBackupEngine, fingerprintPostgresBackup } =
    await import("../snapshot/database-backup.js");
  const postgres = paths.filter(
    (pathname) => result[pathname] !== null && readBackupEngine(pathname).engine === "postgres",
  );
  if (postgres.length) {
    const { createConfigIO } = await import("../config/io.js");
    const { config } = await createConfigIO({
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    for (const pathname of postgres) {
      result[pathname] = await fingerprintPostgresBackup(pathname, config);
    }
  }
  return result;
}
