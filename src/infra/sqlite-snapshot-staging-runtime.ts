import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "./sqlite-lifecycle-errors.js";
import type {
  SqliteNativeSessionLaunch,
  SqliteNativeStagingSession,
} from "./sqlite-readonly-native-resource.types.js";
import type { SqliteSnapshotStagingLaunch } from "./sqlite-snapshot-staging.types.js";

type StagingSession = { worker: SqliteNativeStagingSession; directories: number };

/** Private token connections share a process per launch context, never a copy/read permit. */
export function createSqliteSnapshotStagingRuntime(
  createSession: (launch: SqliteNativeSessionLaunch) => SqliteNativeStagingSession,
) {
  const sessions = new Set<StagingSession>();
  let pending = Promise.resolve();
  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function closeSession(current: StagingSession) {
    await current.worker.close();
    sessions.delete(current);
  }
  function session(launch: SqliteSnapshotStagingLaunch): StagingSession {
    for (const current of sessions) {
      if (current.worker.compatible(launch)) {
        return current;
      }
    }
    // Doctor can retain its report image while inspecting a second private state root.
    const current = {
      worker: createSession({
        ...launch,
        retainLifetime: false,
        retainOnOperationError: true,
      }),
      directories: 0,
    };
    sessions.add(current);
    return current;
  }
  return {
    close() {
      return run(async () => {
        if ([...sessions].some((current) => current.directories !== 0)) {
          throw new Error("SQLite snapshot staging owner still has retained directories");
        }
        const errors: unknown[] = [];
        for (const current of sessions) {
          try {
            await closeSession(current);
          } catch (error) {
            errors.push(error);
          }
        }
        throwSqliteLifecycleErrors(errors, "SQLite snapshot staging owners failed to close");
      });
    },
    async allocate(
      root: string,
      allowLegacyWorker: boolean,
      launch: SqliteSnapshotStagingLaunch,
      preparationId: number,
    ) {
      return run(async () => {
        const current = session(launch);
        let directory: string;
        try {
          // Once dispatched, join the shared child without aborting sibling tokens.
          directory = await current.worker.run(root, {
            mode: allowLegacyWorker ? "staging-create-legacy" : "staging-create",
            preparationId,
          });
          current.directories++;
        } catch (error) {
          if (current.directories === 0) {
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
              if (!retired) {
                await current.worker.run(directory, { mode: "staging-retire" });
                retired = true;
                current.directories--;
              }
              if (current.directories === 0 && sessions.has(current)) {
                await closeSession(current);
              }
            }),
        };
      });
    },
  };
}
