import { note } from "../../packages/terminal-core/src/note.js";
import { resolveOpenClawPackageRootsSync } from "../infra/openclaw-root.js";
import { maintainRetainedUpdateRuntimes } from "../infra/temp-artifact-cleanup.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { inspectDoctorTemporaryDirectories } from "./doctor/shared/temporary-directories.js";

export async function prepareRetainedUpdateRuntimeCleanup(
  env: NodeJS.ProcessEnv,
  options?: { inspectService?: boolean },
) {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const { directories, warnings } = await inspectDoctorTemporaryDirectories(env, options);
  const packageRoots = resolveOpenClawPackageRootsSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  // Loaded only once Doctor runs the cleanup, after its own state admission.
  const { readUpdateRunSettlement } = await import("../infra/update-run-settlement.js");
  return async (
    shouldRepair: boolean,
    authority?: { assertCurrent: () => void; assertResourcesSettled: () => void },
  ): Promise<void> => {
    const lines = await maintainRetainedUpdateRuntimes({
      packageRoots,
      temporaryDirectories: directories,
      repair: shouldRepair,
      assertCurrent:
        authority?.assertCurrent ??
        (() => {
          if (!maintenance?.ownsSchemaMaintenance) {
            throw new Error("Doctor does not hold Gateway maintenance");
          }
          maintenance.assertAdmission();
        }),
      assertResourcesSettled: authority?.assertResourcesSettled,
      readUpdateRun: (runId) => readUpdateRunSettlement(runId, env),
    });
    lines.push(...warnings);
    if (lines.length) {
      note(lines.join("\n"), "Updater runtimes");
    }
  };
}
