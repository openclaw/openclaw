import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import type {
  SqliteNativeSessionLaunch,
  SqliteNativeStagingSession,
} from "./sqlite-readonly-native-resource.types.js";
import type { SqliteSnapshotStagingLaunch } from "./sqlite-snapshot-staging.types.js";

/** Private token connections share one process, never a copy/read worker permit. */
export function createSqliteSnapshotStagingRuntime(
  createSession: (launch: SqliteNativeSessionLaunch) => SqliteNativeStagingSession,
) {
  let worker: SqliteNativeStagingSession | undefined;
  let directories = 0;
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
    await current.close();
    worker = undefined;
  }
  async function session(launch: SqliteSnapshotStagingLaunch) {
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
  return {
    close() {
      return run(async () => {
        if (directories !== 0) {
          throw new Error("SQLite snapshot staging owner still has retained directories");
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
          directory = await current.run(root, {
            mode: allowLegacyWorker ? "staging-create-legacy" : "staging-create",
            preparationId,
          });
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
        let retired = false;
        return {
          directory,
          retire: () =>
            run(async () => {
              if (retired) {
                return;
              }
              await current.run(directory, { mode: "staging-retire" });
              retired = true;
              if (--directories === 0) {
                await closeSession(current);
              }
            }),
        };
      });
    },
  };
}
