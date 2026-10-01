import { note } from "../../packages/terminal-core/src/note.js";
import { resolveOpenClawPackageRootsSync } from "../infra/openclaw-root.js";
import { maintainRetainedUpdateRuntimes } from "../infra/temp-artifact-cleanup.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { inspectDoctorTemporaryDirectories } from "./doctor/shared/temporary-directories.js";

export async function noteRetainedUpdateRuntimes(
  env: NodeJS.ProcessEnv,
  shouldRepair: boolean,
): Promise<void> {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const { directories, warnings } = await inspectDoctorTemporaryDirectories(env);
  const lines = await maintainRetainedUpdateRuntimes({
    packageRoots: resolveOpenClawPackageRootsSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    }),
    temporaryDirectories: directories,
    repair: shouldRepair,
    assertCurrent() {
      if (!maintenance?.ownsSchemaMaintenance) {
        throw new Error("Doctor does not hold Gateway maintenance");
      }
      maintenance.assertAdmission();
    },
  });
  lines.push(...warnings);
  if (lines.length) {
    note(lines.join("\n"), "Updater runtimes");
  }
}
