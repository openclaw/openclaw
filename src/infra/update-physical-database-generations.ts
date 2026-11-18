import { readUpdateDatabaseGenerationObservation } from "./update-database-generations.js";

// Physical backup inspection may load engine configuration; SQLite observation
// workers import only the dependency-light generation owner.
export async function readUpdatePhysicalDatabaseGenerationObservations(paths: readonly string[]) {
  const result = Object.fromEntries(
    paths.map((pathname) => [pathname, readUpdateDatabaseGenerationObservation(pathname)]),
  );
  const { readBackupEngine, fingerprintPostgresBackup } =
    await import("../snapshot/database-backup.js");
  const postgres = paths.filter(
    (pathname) =>
      typeof result[pathname]?.generation === "string" &&
      readBackupEngine(pathname).engine === "postgres",
  );
  if (postgres.length) {
    const { createConfigIO } = await import("../config/io.js");
    const { config } = await createConfigIO({
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    for (const pathname of postgres) {
      result[pathname] = { generation: await fingerprintPostgresBackup(pathname, config) };
    }
  }
  return result;
}

export async function readUpdatePhysicalDatabaseGenerations(paths: readonly string[]) {
  const observations = await readUpdatePhysicalDatabaseGenerationObservations(paths);
  return Object.fromEntries(
    Object.entries(observations).map(([pathname, { generation }]) => [pathname, generation]),
  );
}
