import { note } from "../../packages/terminal-core/src/note.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveOpenClawPackageRootsSync } from "../infra/openclaw-root.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/path-existence.js";
import { isPathInside } from "../infra/path-guards.js";
import { maintainRetainedUpdateRuntimes } from "../infra/temp-artifact-cleanup.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { holdDoctorMaintenanceExit } from "./doctor-maintenance-exit.js";
import type { DoctorMaintenancePending } from "./doctor-maintenance-pending.js";
import { inspectDoctorTemporaryDirectories } from "./doctor/shared/temporary-directories.js";

type RetainedRuntimeAuthority = {
  assertCurrent: () => void;
  assertResourcesSettled?: (directory: string) => void;
  onRecognized?: (directory: string) => void;
};

/**
 * Finds the places an earlier updater could have retained its runtime and returns a
 * maintenance pass over them. Doctor's inspection and repair passes share it.
 */
async function prepareRetainedUpdateRuntimeMaintenance(
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

/**
 * Read-only: whether the cleanup before the stop would try to remove an updater runtime.
 * The report-only pass recognizes the same runtimes; the census and identity checks that
 * can still keep one run only when removing.
 */
export async function checkRetainedUpdateRuntimesPending(
  env: NodeJS.ProcessEnv,
): Promise<DoctorMaintenancePending> {
  const maintain = await prepareRetainedUpdateRuntimeMaintenance(env);
  let recognized = 0;
  await maintain(false, { assertCurrent: () => {}, onRecognized: () => (recognized += 1) });
  return recognized > 0 ? "work" : "none";
}

/**
 * Doctor's `--fix` pass. It runs before Doctor stops the Gateway and needs no stop: each
 * runtime's owner record and the process census decide custody, as for the release
 * updater, which also runs this beside a serving Gateway. Doctor first retires its own
 * idle readers and spawn broker, and keeps a runtime that one of its workers loaded code from.
 */
export async function cleanupRetainedUpdateRuntimesBeforeMaintenance(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // A signal lets the removal in progress finish, so no runtime is left half removed.
  const exit = holdDoctorMaintenanceExit();
  try {
    const maintain = await prepareRetainedUpdateRuntimeMaintenance(env);
    const [{ captureRetainedNativeWorkerSource }, { retireIdleOpenClawStateReadWorkers }] =
      await Promise.all([
        import("../infra/worker-native-lifecycle.js"),
        import("../state/openclaw-state-read-worker.js"),
      ]);
    const nativeSource = captureRetainedNativeWorkerSource();
    let readersRetired: boolean;
    try {
      readersRetired = await retireIdleOpenClawStateReadWorkers(nativeSource);
      await nativeSource.retireIdleBroker();
    } catch (cause) {
      throw new DoctorMaintenanceRefusalError(
        `Doctor inspection resource cleanup failed: ${formatErrorMessage(cause)}. Updater runtimes were kept; resolve this cleanup failure, then rerun openclaw doctor --fix.`,
        { kind: "data-at-risk", reason: "active-mutation" },
        { cause },
      );
    }
    const lines = await maintain(true, {
      assertCurrent: () => exit.signal.throwIfAborted(),
      assertResourcesSettled(directory) {
        // Worker threads share this PID and are invisible to the process census.
        // Cached plugin preparation stays alive for this command, but only a
        // worker loaded from this runtime can hold it.
        const holdsRuntime = nativeSource
          .activeWorkerPaths()
          .some(
            (worker) =>
              worker === undefined ||
              isPathInside(directory, resolveIdentityPathViaExistingAncestorSync(worker)),
          );
        if (!readersRetired || holdsRuntime) {
          throw new Error(
            `independent native work in this process (PID: ${process.pid}); let these holders finish, then rerun openclaw doctor --fix`,
          );
        }
      },
    });
    if (lines.length) {
      note(lines.join("\n"), "Updater runtimes");
    }
  } finally {
    exit.release();
  }
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
