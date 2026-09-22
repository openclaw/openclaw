import { threadId, type MessagePort, type Worker } from "node:worker_threads";
import {
  createSqliteLifecycleAggregateError,
  SqliteCoordinatorError,
} from "../../infra/sqlite-coordinator.js";
import type { SqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  attachStateLifecycleDelegate,
  tryCreateStateLifecycleDelegate,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../../infra/state-database-coordinator.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";

export type SqliteMutationWorkerCoordination = {
  actorId: string;
  databasePath: string;
  stateContext: SqliteWorkerStateContext;
  stateLifecycle?: MessagePort;
};

/** The original request owns this pin until its result or native exit is settled. */
export async function withSqliteMutationWorkerCoordination<T>(
  context: OpenClawStateWorkerContext,
  worker: Worker,
  operationId: number,
  run: (coordination: SqliteMutationWorkerCoordination) => Promise<T>,
): Promise<T> {
  const actorId = `${worker.threadId}:${operationId}`;
  let delegate: ReturnType<typeof tryCreateStateLifecycleDelegate>;
  // Preparation can fail before the mutation request installs its transport owner.
  const preparingError = () => {};
  worker.on("error", preparingError);
  let outcome: { value: T } | { error: unknown };
  try {
    delegate = withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, () =>
      tryCreateStateLifecycleDelegate({ databasePath: context.admission.databasePath, actorId }),
    );
    outcome = {
      value: await run({
        actorId,
        databasePath: context.admission.databasePath,
        stateContext: {
          environment: context.environment,
          coordinatorRuntime: context.coordinatorRuntime,
        },
        // Channel allocation stays inside dispatch, where failure joins native exit.
        get stateLifecycle() {
          return delegate?.port;
        },
      }),
    };
  } catch (error) {
    outcome = { error };
    try {
      await worker.terminate();
    } catch (exitError) {
      outcome.error = new AggregateError(
        [error, exitError],
        "SQLite mutation and Worker exit failed",
        {
          cause: error,
        },
      );
    }
  } finally {
    worker.off("error", preparingError);
  }
  try {
    delegate?.release();
  } catch (error) {
    if (delegate && !delegate.closed) {
      const release = () => {
        delegate.release();
        unregister();
      };
      const unregister = registerOpenClawStateDatabaseAsyncResource({
        close: async (identity) => {
          if (!identity || identity.key === context.admission.identity.key) {
            release();
          }
        },
      });
      context.maintenanceScope?.own(delegate, "shared-resources", release);
    }
    if ("error" in outcome) {
      throw createSqliteLifecycleAggregateError(
        [outcome.error, error],
        "SQLite mutation and coordinator cleanup failed",
        outcome.error,
      );
    }
    process.emitWarning(
      new SqliteCoordinatorError(
        "SQLite mutation settled before coordinator cleanup failed",
        error,
      ),
    );
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

export async function runWithSqliteMutationWorkerCoordination<
  T,
  Options extends OpenClawAgentDatabaseOptions,
>(
  coordination: SqliteMutationWorkerCoordination,
  operationId: number,
  options: Options,
  run: (options: Options) => Promise<T>,
): Promise<T> {
  if (
    coordination.actorId !== `${threadId}:${operationId}` ||
    resolveOpenClawStateSqlitePath(coordination.stateContext.environment) !==
      coordination.databasePath
  ) {
    throw new Error("SQLite mutation Worker shared-state owner changed");
  }
  const delegate = coordination.stateLifecycle
    ? await attachStateLifecycleDelegate(coordination.stateLifecycle, {
        actorId: coordination.actorId,
        databasePath: coordination.databasePath,
        runtimeDirectory: coordination.stateContext.coordinatorRuntime.directory,
      })
    : undefined;
  try {
    return await withStateDatabaseCoordinatorRuntimeDirectory(
      coordination.stateContext.coordinatorRuntime,
      () => {
        const operation = () =>
          run({ ...options, env: { ...options.env, ...coordination.stateContext.environment } });
        return delegate ? delegate.run(operation) : operation();
      },
    );
  } finally {
    delegate?.close();
  }
}
