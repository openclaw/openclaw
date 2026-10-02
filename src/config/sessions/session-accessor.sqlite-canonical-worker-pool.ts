import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "../../state/openclaw-database-preflight-agent-scheduler.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import type { SqliteMutationWorkerTransport } from "./session-accessor.sqlite-worker-transport.js";

type DatabaseOptions = SqliteSessionReclamationPlan["databaseOptions"];
const log = createSubsystemLogger("session-sqlite");

export type SqliteCanonicalValidationWorkerTask = {
  databaseOptions: DatabaseOptions;
  port: MessagePort;
};
export type SqliteCanonicalValidationTaskMessage = {
  type: "ready";
  threadId: number;
  operationId: number;
};
export type SqliteCanonicalValidationTaskResult =
  | { status: "closed" }
  | { status: "failed"; error: string };
export type CanonicalWorkerPool = {
  pool: WorkerTaskPool<SqliteCanonicalValidationWorkerTask, SqliteCanonicalValidationTaskResult>;
  closed: boolean;
  failure?: Error;
  close: () => Promise<void>;
  retryFailedRetirements: () => Promise<void>;
};
const canonicalWorkerPool = new AsyncLocalStorage<CanonicalWorkerPool>();

export function captureCanonicalValidationWorkerPool(): CanonicalWorkerPool | undefined {
  return canonicalWorkerPool.getStore();
}

/** Reuse execution only; each physical database task closes its handles and leases. */
export async function withSqliteCanonicalValidationWorkerPool<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
): Promise<T> {
  const context = captureOpenClawStateWorkerContext({ env });
  let retired = false;
  let closing: Promise<void> | undefined;
  const tasksDrained = createDeferredCore();
  const beforeExit = () => {
    void execution.close().catch((error: unknown) => log.error(String(error)));
  };
  const retainFailure = (cleanupError: unknown) => {
    const latestFailure = toStringifiedError(cleanupError);
    execution.failure ??= latestFailure;
    return execution.failure === latestFailure
      ? execution.failure
      : new AggregateError(
          [execution.failure, latestFailure],
          "Canonical validation failed and native Worker custody remains unsettled",
          { cause: latestFailure },
        );
  };
  const execution: CanonicalWorkerPool = {
    pool: new WorkerTaskPool<
      SqliteCanonicalValidationWorkerTask,
      SqliteCanonicalValidationTaskResult
    >({
      workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptArchive),
      workerOptions: {
        resourceLimits: { maxOldGenerationSizeMb: 512 },
        workerData: {
          type: "sqlite-transcript-archive-v2",
          operation: "canonical-validation-pool",
        },
      },
      maxWorkers: AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
      // The startup scope owns retirement and retains failed native joins for retry.
      idleTimeoutMs: 0,
      validateResult: (result) => {
        // Failed mutation/close replies retire the native slot before rejecting its task.
        if (result.status !== "closed") {
          throw new Error(result.error);
        }
      },
    }),
    closed: false,
    retryFailedRetirements: async () => {
      execution.closed = true;
      try {
        await execution.pool.retryFailedRetirements();
      } catch (error) {
        // Preserve custody for another attempt without blocking healthy owners' graceful closes.
        log.error(String(retainFailure(error)));
      }
    },
    close: async () => {
      execution.closed = true;
      // Database owners retain admission through graceful close; this pool owns idle execution.
      await tasksDrained.promise;
      if (closing) {
        try {
          await closing;
          return;
        } catch {
          // Retry after the failed join settles; rejoining it would strand task custody.
        }
      }
      if (retired) {
        return;
      }
      return (closing ??= execution.pool
        .close(execution.failure)
        .then(() => {
          retired = true;
          unregister();
          process.off("beforeExit", beforeExit);
        })
        .catch((cleanupError: unknown) => {
          throw retainFailure(cleanupError);
        })
        .finally(() => {
          closing = undefined;
        }));
    },
  };
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    close: async (identity) => {
      if (!identity || identity.key === context.admission.identity.key) {
        await execution.close();
      }
    },
  });
  // Failed exit cleanup retains custody for explicit retries without restarting the event loop.
  process.once("beforeExit", beforeExit);
  try {
    context.maintenanceScope?.own(execution, "shared-resources", execution.close);
    return await canonicalWorkerPool.run(execution, run);
  } catch (error) {
    execution.failure ??= toStringifiedError(error);
    throw error;
  } finally {
    tasksDrained.resolve();
    await execution.close();
  }
}

export async function startCanonicalValidationTask(
  execution: CanonicalWorkerPool,
  databaseOptions: DatabaseOptions,
): Promise<SqliteMutationWorkerTransport> {
  if (execution.closed) {
    throw execution.failure ?? new Error("Canonical validation Worker pool is closed");
  }
  const { port1: channel, port2 } = new MessageChannel();
  const controller = new AbortController();
  const ready = createDeferredCore<SqliteCanonicalValidationTaskMessage>();
  let active = true;
  let custodyReleased = false;
  const custody = createDeferredCore();
  let taskFailure: Error | undefined;
  const retryRetirement = async (failure: Error) => {
    execution.closed = true;
    execution.failure ??= failure;
    await execution.retryFailedRetirements();
  };
  channel.on("message", (message: SqliteCanonicalValidationTaskMessage) => {
    if (message.type === "ready") {
      ready.resolve(message);
    }
  });
  const completion = execution.pool
    .run(
      { databaseOptions, port: port2 },
      {
        transferList: (task) => [task.port],
        signal: controller.signal,
        onRequest: async () => {
          throw new Error("Canonical validation task must request admission through its own port");
        },
        onInputConsumed: () => {
          custodyReleased = true;
          custody.resolve();
        },
      },
    )
    .then(() => undefined)
    .catch(async (error: unknown) => {
      taskFailure = toStringifiedError(error);
      if (!custodyReleased) {
        // Pool rejection can precede a failed native join. Retry once now, independently
        // of the outer scope, and keep the request's writer admission until its receipt.
        void retryRetirement(taskFailure);
        await custody.promise;
      }
      throw execution.failure ?? taskFailure;
    })
    .finally(() => {
      active = false;
      port2.close();
    });
  void completion.then(
    () => ready.reject(new Error("Canonical validation task closed before readiness")),
    (error: unknown) => ready.reject(error),
  );
  try {
    const started = await ready.promise;
    return {
      kind: "pooled",
      channel,
      threadId: started.threadId,
      initialOperationId: started.operationId,
      completion,
      custodyReleased: () => custodyReleased,
      terminate: async () => {
        // This controller belongs to one task, never to its reused native slot.
        if (active) {
          controller.abort(new Error("Canonical validation task was terminated"));
        }
        if (taskFailure && !custodyReleased) {
          await retryRetirement(taskFailure);
        }
        await completion.catch((error: unknown) => {
          if (!custodyReleased) {
            throw error;
          }
        });
      },
    };
  } catch (error) {
    channel.close();
    throw error;
  }
}
