import path from "node:path";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { restoreScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

/** Scoped archives are applied in place, never substituted for a complete database. */
export async function restoreDoctorMigrationBackup(params: {
  sourcePath: string;
  backupPath: string;
  env?: NodeJS.ProcessEnv;
}) {
  const sourcePath = path.resolve(params.sourcePath);
  const backupPath = path.resolve(params.backupPath);
  return withDoctorSqliteMaintenanceLock({
    env: params.env,
    operation: "scoped migration backup restore",
    protectedPaths: [...resolveSqliteDatabaseFilePaths(sourcePath), backupPath],
    run: (authority) => {
      restoreScopedMigrationSnapshot({
        sourcePath,
        backupPath,
        assertCurrent: () => authority.assertCurrent(),
      });
      return { restored: true, sourcePath, backupPath };
    },
  });
}
