import { note } from "../../packages/terminal-core/src/note.js";
import { resolveOpenClawPackageRootsSync } from "../infra/openclaw-root.js";
import { maintainRetainedUpdateRuntimes } from "../infra/temp-artifact-cleanup.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { inspectDoctorTemporaryDirectories } from "./doctor/shared/temporary-directories.js";

type RetainedRuntimeAuthority = {
  assertCurrent: () => void;
  assertResourcesSettled?: (directory: string) => void;
};

/**
 * Finds the places an earlier updater could have retained its runtime and returns a
 * maintenance pass over them. Doctor and release updates share it; callers present the lines.
 */
export async function prepareRetainedUpdateRuntimeMaintenance(
  env: NodeJS.ProcessEnv,
  options?: { inspectService?: boolean; packageRoots?: readonly string[] },
) {
  const { directories, warnings } = await inspectDoctorTemporaryDirectories(env, options);
  const packageRoots = [
    ...resolveOpenClawPackageRootsSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    }),
    // An installation this process no longer runs from, such as the package a release replaced.
    ...(options?.packageRoots ?? []),
  ];
  return async (repair: boolean, authority: RetainedRuntimeAuthority): Promise<string[]> => [
    ...(await maintainRetainedUpdateRuntimes({
      packageRoots,
      temporaryDirectories: directories,
      repair,
      ...authority,
    })),
    ...warnings,
  ];
}

export async function prepareRetainedUpdateRuntimeCleanup(
  env: NodeJS.ProcessEnv,
  options?: { inspectService?: boolean },
) {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const maintain = await prepareRetainedUpdateRuntimeMaintenance(env, options);
  return async (
    shouldRepair: boolean,
    authority?: { assertCurrent: () => void; assertResourcesSettled: (directory: string) => void },
  ): Promise<void> => {
    const lines = await maintain(
      shouldRepair,
      authority ?? {
        assertCurrent: () => {
          if (!maintenance?.ownsSchemaMaintenance) {
            throw new Error("Doctor does not hold Gateway maintenance");
          }
          maintenance.assertAdmission();
        },
      },
    );
    if (lines.length) {
      note(lines.join("\n"), "Updater runtimes");
    }
  };
}
