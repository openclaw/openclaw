import { performance } from "node:perf_hooks";
import { threadId, type MessagePort } from "node:worker_threads";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
  SqliteCoordinatorError,
} from "../../infra/sqlite-coordinator.js";
import type { SqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { acquireStateDatabaseCoordinatorWithWait } from "../../infra/state-database-coordinator-acquisition.js";
import {
  attachStateLifecycleDelegate,
  tryCreateStateLifecycleDelegate,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../../infra/state-database-coordinator.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  sqliteMutationWorkerThreadId,
  terminateSqliteMutationWorker,
  type SqliteMutationWorkerTransport,
} from "./session-accessor.sqlite-worker-transport.js";

export type SqliteMutationWorkerCoordination = {
  actorId: string;
  databasePath: string;
  stateContext: SqliteWorkerStateContext;
  stateLifecycle?: MessagePort;
};

async function prepareLifecycleDelegate(context: OpenClawStateWorkerContext, actorId: string) {
  // This custody also drains retained workers after read admission is revoked.
  // Request owners validate new work; cleanup keeps its original native custody.
  const coordinator = await acquireStateDatabaseCoordinatorWithWait({
    operation: "mutation-worker-admission",
    databasePath: context.admission.databasePath,
    runtime: context.coordinatorRuntime,
    deadlineMs: performance.now() + OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  });
  return withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, () =>
    runWithSqliteCoordinator(coordinator, "SQLite mutation Worker lifecycle admission", () => {
      return tryCreateStateLifecycleDelegate({
        databasePath: context.admission.databasePath,
        actorId,
      });
    }),
  );
}

/** The original request owns this pin until its result or native exit is settled. */
export async function withSqliteMutationWorkerCoordination<T>(
  context: OpenClawStateWorkerContext,
  transport: SqliteMutationWorkerTransport,
  operationId: number,
  run: (coordination: SqliteMutationWorkerCoordination) => Promise<T>,
): Promise<T> {
  const worker = transport.channel;
  const actorId = `${sqliteMutationWorkerThreadId(transport)}:${operationId}`;
  // Preparation can fail before the mutation request installs its transport owner.
  const preparingError = () => {};
  worker.on("error", preparingError);
  try {
    return await withSqliteWorkerLifecycleCoordination(context, actorId, run, async () => {
      await terminateSqliteMutationWorker(transport);
    });
  } finally {
    worker.off("error", preparingError);
  }
}

/** Each transport joins its native operation before relinquishing shared-state custody. */
export async function withSqliteWorkerLifecycleCoordination<T>(
  context: OpenClawStateWorkerContext,
  actorId: string,
  run: (coordination: SqliteMutationWorkerCoordination) => Promise<T>,
  settleFailure: () => Promise<void>,
): Promise<T> {
  let delegate: ReturnType<typeof tryCreateStateLifecycleDelegate>;
  let outcome: { value: T } | { error: unknown };
  try {
    delegate = await prepareLifecycleDelegate(context, actorId);
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
      await settleFailure();
    } catch (exitError) {
      outcome.error = new AggregateError(
        [error, exitError],
        "SQLite mutation and Worker exit failed",
        {
          cause: error,
        },
      );
    }
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
