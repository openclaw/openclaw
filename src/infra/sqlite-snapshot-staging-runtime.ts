import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import type {
  SqliteNativeSessionLaunch,
  SqliteNativeStagingSession,
} from "./sqlite-readonly-native-resource.types.js";
import { isSameSqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker-session.js";
import type { SqliteSnapshotStagingLaunch } from "./sqlite-snapshot-staging.types.js";

/** Private token connections share one process, never a copy/read worker permit. */
export function createSqliteSnapshotStagingRuntime(
  createSession: (launch: SqliteNativeSessionLaunch) => SqliteNativeStagingSession,
) {
  let worker: SqliteNativeStagingSession | undefined;
  let directories = 0;
  let activeLaunch: SqliteSnapshotStagingLaunch | undefined;
  let closing: SqliteNativeStagingSession | undefined;
  let pending = Promise.resolve();
  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function closeSession(current: SqliteNativeStagingSession) {
    closing = current;
    await current.close();
    if (worker === current) {
      worker = undefined;
    }
    if (directories === 0) {
      activeLaunch = undefined;
    }
    closing = undefined;
  }
  async function session(launch: SqliteSnapshotStagingLaunch) {
    if (closing) {
      await closeSession(closing);
    }
    if (activeLaunch && !isSameSqliteReadOnlyWorkerLaunch(activeLaunch, launch)) {
      throw new Error(
        "SQLite snapshot staging owner launch context changed; retire its snapshots before retrying",
      );
    }
    if (worker?.isRetired()) {
      await closeSession(worker);
    }
    worker ??= createSession({
      ...launch,
      retainLifetime: false,
      retainOnOperationError: true,
    });
    if (!worker.compatible(launch)) {
      throw new Error(
        "SQLite snapshot staging owner launch context changed; retire its snapshots before retrying",
      );
    }
    return worker;
  }
  async function retireToken(
    current: SqliteNativeStagingSession,
    directory: string,
    launch: SqliteSnapshotStagingLaunch,
  ) {
    let failure: unknown;
    if (!current.isRetired()) {
      try {
        await current.run(directory, { mode: "staging-retire" });
        return current;
      } catch (error) {
        if (!current.isRetired()) {
          throw error;
        }
        failure = error;
      }
    }
    try {
      await closeSession(current);
      const replacement = await session(launch);
      await replacement.run(directory, { mode: "staging-reconcile" });
      return replacement;
    } catch (error) {
      if (failure !== undefined) {
        throw createSqliteLifecycleAggregateError(
          [failure, error],
          "SQLite snapshot retirement and reconciliation failed",
          failure,
        );
      }
      throw error;
    }
  }
  return {
    close() {
      return run(async () => {
        if (directories !== 0) {
          throw new Error("SQLite snapshot staging owner still has retained directories");
        }
        if (closing) {
          await closeSession(closing);
        }
        if (worker) {
          await closeSession(worker);
        }
      });
    },
    async allocate(
      root: string,
      allowLegacyWorker: boolean,
      launch: SqliteSnapshotStagingLaunch,
      preparationId: number,
    ) {
      return run(async () => {
        const current = await session(launch);
        let directory: string;
        try {
          // Once dispatched, join the shared child without aborting sibling tokens.
          const result = await current.run(root, {
            mode: allowLegacyWorker ? "staging-create-legacy" : "staging-create",
            preparationId,
          });
          if (typeof result !== "string") {
            throw new Error("SQLite snapshot staging owner returned an invalid directory");
          }
          directory = result;
          activeLaunch ??= launch;
          directories++;
        } catch (error) {
          if (directories === 0) {
            try {
              await closeSession(current);
            } catch (cleanupError) {
              throw createSqliteLifecycleAggregateError(
                [error, cleanupError],
                "SQLite snapshot allocation and owner cleanup failed",
                error,
              );
            }
          }
          throw error;
        }
        let tokenRetired = false;
        let lastDirectory = false;
        let complete = false;
        let retirementSession = current;
        return {
          directory,
          retire: () =>
            run(async () => {
              if (complete) {
                return;
              }
              if (!tokenRetired) {
                // Cleanup stays with the allocation's captured launch, even after ambient changes.
                retirementSession = await retireToken(current, directory, launch);
                tokenRetired = true;
                lastDirectory = --directories === 0;
              }
              if (lastDirectory) {
                await closeSession(retirementSession);
              }
              complete = true;
            }),
        };
      });
    },
  };
}
