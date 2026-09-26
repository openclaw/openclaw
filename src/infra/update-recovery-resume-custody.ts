import type { UpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { withFileLock } from "./file-lock.js";
import {
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
} from "./state-database-coordinator.js";

const CONFIG_LOCK_OPTIONS = {
  retries: { retries: 80, factor: 1.2, minTimeout: 25, maxTimeout: 250, randomize: true },
  stale: 30_000,
} as const;

/** Reacquire only the exact durable B/C/T resource inventory. The standalone
 * helper has no process-local Gateway caches to drain; native coordinators and
 * config file locks exclude every cooperating writer across processes. */
export async function withUpdateRecoveryResumeCustody<T>(
  params: {
    manifest: UpdateRecoveryBackupManifest;
    assertOwned: () => void;
  },
  operation: (custody: { assertCurrent: () => void }) => Promise<T>,
): Promise<T> {
  const assertOriginal = params.assertOwned.bind(params);
  const locks = [...new Set(params.manifest.configPaths)].toSorted();
  const withLocks = (index: number, run: () => Promise<T>): Promise<T> =>
    index < locks.length
      ? withFileLock(locks[index]!, CONFIG_LOCK_OPTIONS, () => {
          assertOriginal();
          return withLocks(index + 1, run);
        })
      : run();
  return withLocks(0, async () => {
    const coordinators: Array<ReturnType<typeof acquireStateDatabaseCoordinator>> = [];
    const exclusions: Array<ReturnType<typeof acquireStateDatabaseHandleExclusion>> = [];
    try {
      for (const database of params.manifest.databases ?? []) {
        assertOriginal();
        coordinators.push(
          acquireStateDatabaseCoordinator({ databasePath: database.path, busyTimeoutMs: 0 }),
        );
        exclusions.push(
          acquireStateDatabaseHandleExclusion({ databasePath: database.path, busyTimeoutMs: 0 }),
        );
      }
      const assertCurrent = () => {
        assertOriginal();
        for (const coordinator of coordinators) {
          if (coordinator.closed) {
            throw new Error("Reverse recovery database lifecycle custody is closed.");
          }
        }
        for (const exclusion of exclusions) {
          exclusion.assertCurrent();
        }
      };
      const run = (index: number): Promise<T> =>
        index < exclusions.length
          ? exclusions[index]!.runWithSourceReads(() => run(index + 1))
          : operation({ assertCurrent });
      const value = await run(0);
      assertCurrent();
      return value;
    } finally {
      for (const exclusion of exclusions.toReversed()) {
        exclusion.release();
      }
      for (const coordinator of coordinators.toReversed()) {
        coordinator.release();
      }
    }
  });
}
