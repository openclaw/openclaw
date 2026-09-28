import { performance } from "node:perf_hooks";
import { threadId, type MessagePort } from "node:worker_threads";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
  SqliteCoordinatorError,
} from "../../infra/sqlite-coordinator.js";
import { retainSqliteWriteAdmissionService } from "../../infra/sqlite-transaction.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  acquireSqliteWorkerLifecycle,
  createSqliteWorkerLifecyclePreparation,
} from "../../infra/sqlite-worker-lifecycle-preparation.js";
import type { SqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { acquireStateDatabaseCoordinatorWithWait } from "../../infra/state-database-coordinator-acquisition.js";
import {
  attachStateLifecycleDelegate,
  resolveStateDatabaseCoordinatorPath,
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
  reconciliation?: {
    identity: string;
    open: MessagePort;
    close: MessagePort;
  };
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
  mode: "retained" | "reconciliation" = "retained",
): Promise<T> {
  let delegate: ReturnType<typeof tryCreateStateLifecycleDelegate>;
  const phaseDelegates: NonNullable<typeof delegate>[] = [];
  const phases: ReturnType<typeof createSqliteWorkerLifecyclePreparation>[] = [];
  const controller = new AbortController();
  let releaseService: (() => void) | undefined;
  let outcome: { value: T } | { error: unknown };
  try {
    delegate =
      mode === "retained"
        ? await prepareLifecycleDelegate(context, actorId)
        : withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, () =>
            tryCreateStateLifecycleDelegate({
              databasePath: context.admission.databasePath,
              actorId,
            }),
          );
    const identity = context.admission.identity.key;
    let openAdmitted = false;
    const preparePhase = (phase: "open" | "close") => {
      const runtime =
        phase === "close"
          ? { ...context.coordinatorRuntime, keepAlive: false }
          : context.coordinatorRuntime;
      const preparation = createSqliteWorkerLifecyclePreparation({
        signal: controller.signal,
        assertCurrent() {
          // Sealing new reads cannot revoke cleanup of this already-admitted native operation.
          if (phase === "open" || !openAdmitted) {
            context.admission.assertCurrent();
          }
          assertExistingDatabaseIdentity(context.admission.databasePath, identity);
        },
        borrow: () =>
          withStateDatabaseCoordinatorRuntimeDirectory(runtime, () => {
            delegate ??= tryCreateStateLifecycleDelegate({
              databasePath: context.admission.databasePath,
              actorId,
            });
            // Every phase needs a fresh port; retain the first late parent owner through settlement.
            const phaseDelegate = delegate
              ? tryCreateStateLifecycleDelegate({
                  databasePath: context.admission.databasePath,
                  actorId: `${actorId}:${phase}`,
                })
              : undefined;
            if (phaseDelegate) {
              phaseDelegates.push(phaseDelegate);
            }
            return phaseDelegate?.port;
          }),
        admit: () => undefined,
        dispatch() {
          if (phase === "open") {
            openAdmitted = true;
          }
        },
        receiveResult() {
          throw new Error("Reconciliation lifecycle preparation received an unexpected result");
        },
      });
      phases.push(preparation);
      return preparation.port;
    };
    if (!delegate && mode === "reconciliation") {
      releaseService = retainSqliteWriteAdmissionService(
        [
          resolveStateDatabaseCoordinatorPath({
            databasePath: context.admission.databasePath,
            runtimeDirectory: context.coordinatorRuntime.directory,
            uid: process.getuid?.(),
          }),
        ],
        () => phases.forEach((phase) => phase.service()),
      );
    }
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
        ...(!delegate && mode === "reconciliation"
          ? {
              reconciliation: {
                identity,
                open: preparePhase("open"),
                close: preparePhase("close"),
              },
            }
          : {}),
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
  const cleanupErrors: unknown[] = [];
  for (const finish of [
    ...phases.map((phase) => () => phase.finish()),
    ...(releaseService ? [releaseService] : []),
  ]) {
    try {
      finish();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const held of [...phaseDelegates, ...(delegate ? [delegate] : [])]) {
    try {
      held.release();
    } catch (error) {
      cleanupErrors.push(error);
      if (!held.closed) {
        const release = () => {
          held.release();
          unregister();
        };
        const unregister = registerOpenClawStateDatabaseAsyncResource({
          close: async (identity) => {
            if (!identity || identity.key === context.admission.identity.key) {
              release();
            }
          },
        });
        context.maintenanceScope?.own(held, "shared-resources", release);
      }
    }
  }
  if (cleanupErrors.length) {
    const error =
      cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "SQLite coordinator cleanup failed");
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

/** Reconciliation keeps its durable agent lease while yielding between native state phases. */
export async function runSqliteReconciliationLifecyclePhase<T>(
  coordination: SqliteMutationWorkerCoordination,
  phase: "open" | "close",
  operation: () => T,
  onUnsettled: () => void,
): Promise<T> {
  const preparation = coordination.reconciliation;
  if (!preparation) {
    // The caller's whole-request delegate retains its original borrowing contract.
    return operation();
  }
  const runtime =
    phase === "close"
      ? { ...coordination.stateContext.coordinatorRuntime, keepAlive: false }
      : coordination.stateContext.coordinatorRuntime;
  const port = preparation[phase];
  const prepared = await acquireSqliteWorkerLifecycle({
    port,
    databasePath: coordination.databasePath,
    actorId: `${coordination.actorId}:${phase}`,
    deadlineNs: process.hrtime.bigint() + BigInt(OPENCLAW_SQLITE_BUSY_TIMEOUT_MS) * 1_000_000n,
    runtime,
    onUnsettled,
  });
  try {
    return withStateDatabaseCoordinatorRuntimeDirectory(runtime, () => {
      const run = () => {
        assertExistingDatabaseIdentity(coordination.databasePath, preparation.identity);
        return operation();
      };
      return runWithSqliteCoordinator(
        {
          release() {
            try {
              prepared.coordinator?.release();
            } catch (error) {
              onUnsettled();
              throw error;
            }
          },
        },
        `transcript reconciliation ${phase}`,
        () => (prepared.delegate ? prepared.delegate.run(run) : run()),
      );
    });
  } finally {
    prepared.delegate?.close();
    port.close();
  }
}
