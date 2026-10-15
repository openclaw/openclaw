import { AsyncLocalStorage } from "node:async_hooks";
import {
  createRetainedOperation,
  flatMapRetainedOperation,
  mapRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { acquireSqliteDatabaseAdmissionTurn } from "../infra/sqlite-database-admission-turn.js";
import { resolveSqliteDatabaseFilePath } from "../infra/sqlite-database-admission.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import {
  captureRetainedNativeWorkerSource,
  type RetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";
import {
  closeReadResources,
  createStateReadPool,
  startReadTask,
  stateReadPools,
  type ReadPool,
} from "./openclaw-state-read-pool.js";
import { requestBytes } from "./openclaw-state-read-request.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadCommand,
  OpenClawStateReadLocation,
  OpenClawStateReadOutcome,
  OpenClawStateReadOptions,
  OpenClawStateReadRequest,
  OpenClawStateReadReply,
} from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

export function decodeOpenClawStateReadReply(
  reply: OpenClawStateReadReply,
): OpenClawStateReadOutcome {
  if (reply.ok) {
    return { value: reply };
  }
  const error = new Error(reply.message);
  retainOpenClawStateWorkerErrorPayload(error, reply.error);
  return {
    error: hydrateOpenClawStateWorkerError(error, { includeOrdinary: true }),
    sourceAdmitted: reply.sourceAdmitted === true,
  };
}

type ReadOperation = { service(): void; close(): Promise<void> };
type ReadRuntime = {
  nativeSource: RetainedNativeWorkerSource;
  workerUrl: URL;
  operations: Set<ReadOperation>;
  servicing: boolean;
  sealed: boolean;
  pool?: ReadPool;
  awaitedPool?: ReadPool;
  closing?: Promise<void>;
  stopping?: Promise<void>;
};

async function closeReadPool(state: ReadRuntime): Promise<void> {
  if (state.closing) {
    return await state.closing;
  }
  const pools = stateReadPools(state);
  if (!pools.length) {
    return;
  }
  const closing = (async () => {
    const results = await Promise.allSettled(
      pools.map(async (pool) => {
        await closeReadResources(pool);
        await pool.close();
      }),
    );
    throwSqliteLifecycleErrors(
      results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      "Shared-state reader pools cleanup failed",
    );
    state.pool = undefined;
    state.awaitedPool = undefined;
  })();
  state.closing = closing;
  try {
    await closing;
  } finally {
    state.closing = undefined;
  }
}

function readRuntimes() {
  return resolveGlobalSingleton(Symbol.for("openclaw.stateReadWorkers"), () => {
    const sources = new Map<RetainedNativeWorkerSource, ReadRuntime>();
    registerOpenClawStateDatabaseAsyncResource({
      phase: "after-resources",
      async close(identity) {
        const results = await Promise.allSettled(
          [...sources.values()].map(async (state) => {
            if (identity) {
              const resources = await Promise.allSettled(
                stateReadPools(state).map((pool) => closeReadResources(pool, identity.key)),
              );
              throwSqliteLifecycleErrors(
                resources.flatMap((result) =>
                  result.status === "rejected" ? [result.reason] : [],
                ),
                "Shared-state reader resources cleanup failed",
              );
            } else {
              await closeReadPool(state);
            }
          }),
        );
        throwSqliteLifecycleErrors(
          results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
          "Shared-state reader source cleanup failed",
        );
      },
    });
    registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind !== "opened" && event.identity) {
        const identity = event.identity;
        for (const state of sources.values()) {
          void Promise.allSettled(
            stateReadPools(state).map((pool) => closeReadResources(pool, identity.key)),
          )
            .then((results) =>
              throwSqliteLifecycleErrors(
                results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
                "Shared-state reader invalidation failed",
              ),
            )
            .catch((error: unknown) => {
              // The worker retains failed cleanup; canonical path close retries it.
              process.emitWarning(`Shared-state reader invalidation failed: ${String(error)}`);
            });
        }
      }
    });
    return sources;
  });
}

/** Retire cached workers only after every independently admitted reader has joined. */
export async function retireIdleOpenClawStateReadWorkers(
  nativeSource: RetainedNativeWorkerSource,
): Promise<boolean> {
  const state = readRuntimes().get(nativeSource);
  if (!state) {
    return true;
  }
  if (state.operations.size > 0) {
    return false;
  }
  await closeReadPool(state);
  return true;
}

function readPool(state: ReadRuntime, admitted: boolean, awaitedOnly: boolean) {
  // Accepted owners may still need a final read while generation admission is sealed.
  if ((state.sealed && !admitted) || state.closing) {
    throw new WorkerTaskError("Shared-state readers are closing", "unavailable");
  }
  // Reuse an existing serviceable worker; cold promise-only reads need no native supervisor.
  const retained = !awaitedOnly || state.pool !== undefined;
  const key = retained ? "pool" : "awaitedPool";
  if (!state[key]) {
    state[key] = createStateReadPool(state.workerUrl, retained ? state.nativeSource : undefined);
  }
  return { pool: state[key], retained };
}

/** Capture the execution source before snapshot preparation yields. */
export function captureOpenClawStateReadSource() {
  const captured = captureRuntimeWorkerSource(resolveRuntimeProcessEntrypointUrl("stateRead"));
  const nativeSource = captureRetainedNativeWorkerSource({
    runtimeGeneration: captured.runtimeGeneration,
  });
  const sources = readRuntimes();
  let runtime = sources.get(nativeSource);
  if (!runtime) {
    const created: ReadRuntime = {
      nativeSource,
      workerUrl: captured.moduleUrl,
      operations: new Set(),
      servicing: false,
      sealed: false,
    };
    nativeSource.retain(created, () => {
      created.sealed = true;
      if (!created.stopping) {
        created.stopping = Promise.resolve()
          .then(async () => {
            const results = await Promise.allSettled(
              [...created.operations].map((operation) =>
                Promise.resolve().then(() => operation.close()),
              ),
            );
            throwSqliteLifecycleErrors(
              results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
              "Shared-state reader source cleanup failed",
            );
            await closeReadPool(created);
            sources.delete(nativeSource);
          })
          .finally(() => {
            created.stopping = undefined;
          });
      }
      return created.stopping;
    });
    sources.set(nativeSource, created);
    runtime = created;
  }
  const state = runtime;
  const admitted = new Set<ReadOperation>();
  return {
    createTransport: (
      command: OpenClawStateReadCommand,
      onChunk?: OpenClawStateReadOptions["onChunk"],
      onChunkAsync?: OpenClawStateReadOptions["onChunkAsync"],
      awaitedOnly = false,
    ) =>
      createReadTransport(
        command,
        state,
        () => admitted.size > 0,
        onChunk,
        onChunkAsync,
        awaitedOnly,
      ),
    own(service: () => void, close: () => Promise<void>): () => void {
      if (state.sealed || state.closing) {
        throw new WorkerTaskError("Shared-state readers are closing", "unavailable");
      }
      const inContext = AsyncLocalStorage.snapshot();
      const operation: ReadOperation = {
        service: () => inContext(service),
        close: () => inContext(close),
      };
      state.operations.add(operation);
      admitted.add(operation);
      // A rejected result can still own failed cleanup. Only its owner releases it.
      return () => {
        state.operations.delete(operation);
        admitted.delete(operation);
      };
    },
    service() {
      if (state.servicing) {
        return;
      }
      state.servicing = true;
      const errors: unknown[] = [];
      try {
        // Reentrant admission belongs to the next service pass, not this captured frontier.
        const operations = Array.from(state.operations);
        for (const operation of operations) {
          if (state.operations.has(operation)) {
            try {
              operation.service();
            } catch (error) {
              errors.push(error);
            }
          }
        }
      } finally {
        state.servicing = false;
      }
      throwSqliteLifecycleErrors(errors, "Shared-state reader source cleanup failed");
    },
  };
}

function createReadTransport(
  command: OpenClawStateReadCommand,
  state: ReadRuntime,
  ownsAdmission: () => boolean,
  onChunk?: OpenClawStateReadOptions["onChunk"],
  onChunkAsync?: OpenClawStateReadOptions["onChunkAsync"],
  awaitedOnly = false,
) {
  // Capture nested input before the read owner can yield during snapshot preparation.
  const capturedCommand = structuredClone(command);
  type ReadTask = ReturnType<ReadPool["startTask"]>;
  const tasks = new Map<ReadTask, { retire: boolean }>();
  let closed = false;
  let closing: RetainedOperation<void> | undefined;
  let pendingChunks = 0;

  const startCloseTask = (task: ReadTask): RetainedOperation<void> => {
    try {
      return mapRetainedOperation(
        task.release(tasks.get(task)?.retire ? { retire: true } : undefined),
        () => {
          tasks.delete(task);
        },
      );
    } catch (error) {
      const completion = createRetainedOperation<void>(() => {});
      completion.reject(error);
      return completion.operation;
    }
  };

  const startRun = (
    context: OpenClawStateWorkerContext,
    location: string,
    checkFreshAdmission: boolean,
    readCommand: OpenClawStateReadRequest["command"],
    authority: OpenClawStateReadAuthority,
    expectedIdentity?: string,
    snapshotRoot?: string,
  ) => {
    const inContext = AsyncLocalStorage.snapshot();
    let task: ReadTask | undefined;
    let releaseAdmission: (() => void) | undefined;
    let retireAfterRead = false;
    const cleanup = { retire: true };
    const completion = createRetainedOperation<OpenClawStateReadOutcome>(() => inContext(service));
    function service() {
      if (!task || completion.operation.read().status !== "pending") {
        return;
      }
      let outcome: OpenClawStateReadOutcome;
      try {
        task.service();
        const read = task.read();
        if (read.status === "pending") {
          return;
        }
        if (read.status === "rejected") {
          throw read.error;
        }
        const reply = read.value;
        cleanup.retire = retireAfterRead || Boolean(reply.nativeCleanupFailure);
        outcome = decodeOpenClawStateReadReply(reply);
      } catch (error) {
        outcome = { error };
      }
      releaseAdmission?.();
      releaseAdmission = undefined;
      // Native closes and quarantine cleanup can require exit even when the domain read succeeds.
      cleanup.retire ||= "error" in outcome;
      completion.resolve(outcome);
    }
    try {
      if (closed) {
        throw new WorkerTaskError("Shared-state read transport is closed", "unavailable");
      }
      const request: OpenClawStateReadRequest = {
        context: {
          databaseEngineInput: context.databaseEngineInput,
          environment: { ...context.environment },
          existingSchemaPath: context.existingSchemaPath,
          stateIntegrity: context.stateIntegrity,
        },
        databasePath: context.admission.databasePath,
        location,
        checkFreshAdmission,
        expectedIdentity,
        snapshotRoot,
        command: { ...readCommand },
      };
      const pool = readPool(state, ownsAdmission(), awaitedOnly);
      // Maintenance reuses this reader; standalone inspection releases it before metadata loads.
      retireAfterRead = !pool.retained && !context.maintenanceScope && readCommand.type !== "admit";
      task = startReadTask(
        pool,
        () => {
          const turn = acquireSqliteDatabaseAdmissionTurn(resolveSqliteDatabaseFilePath(location));
          if (!turn) {
            authority.assertCurrent();
            return request;
          }
          return turn.then((release) => {
            releaseAdmission = release;
            try {
              authority.assertCurrent();
              return request;
            } catch (error) {
              releaseAdmission();
              releaseAdmission = undefined;
              throw error;
            }
          });
        },
        {
          signal: authority.signal,
          inputBytes: requestBytes(request),
          diagnosticOperation: readCommand.type,
          ...(onChunkAsync
            ? {
                async onRequest(value: unknown, { signal: taskSignal }: { signal: AbortSignal }) {
                  authority.assertCurrent();
                  const signal = AbortSignal.any([authority.signal, taskSignal]);
                  signal.throwIfAborted();
                  pendingChunks += 1;
                  try {
                    await onChunkAsync(value, signal);
                    signal.throwIfAborted();
                    authority.assertCurrent();
                    return { input: null, timeoutMs: 300_000 };
                  } finally {
                    pendingChunks -= 1;
                    closing?.service();
                  }
                },
              }
            : onChunk
              ? {
                  onRequestSync(value: unknown) {
                    authority.assertCurrent();
                    onChunk(value);
                    return { input: null, timeoutMs: 300_000 };
                  },
                }
              : {}),
        },
      );
      tasks.set(task, cleanup);
      void task.result.then(
        () => completion.operation.service(),
        () => completion.operation.service(),
      );
      completion.operation.service();
    } catch (error) {
      releaseAdmission?.();
      releaseAdmission = undefined;
      completion.reject(error);
    }
    return { task, operation: completion.operation };
  };

  const startValidateFresh = (
    context: OpenClawStateWorkerContext,
    authority: OpenClawStateReadAuthority,
  ): RetainedOperation<void> => {
    const run = startRun(
      context,
      context.admission.databasePath,
      true,
      { type: "admit" },
      authority,
    );
    return flatMapRetainedOperation(run.operation, (read) => {
      if ("error" in read) {
        throw read.error;
      }
      authority.assertCurrent();
      if (!run.task) {
        throw new Error("Shared-state admission completed without its retained task");
      }
      return startCloseTask(run.task);
    });
  };
  const startRead = (source: OpenClawStateReadLocation, authority: OpenClawStateReadAuthority) =>
    startRun(
      source.context,
      source.location,
      source.checkFreshAdmission,
      capturedCommand,
      authority,
      source.expectedIdentity,
      source.snapshotRoot,
    ).operation;
  const startClose = (): RetainedOperation<void> => {
    closed = true;
    if (closing) {
      return closing;
    }
    const releases = [...tasks.keys()].map(startCloseTask);
    const inContext = AsyncLocalStorage.snapshot();
    const completion = createRetainedOperation<void>(() => inContext(service));
    closing = completion.operation;
    function service() {
      if (completion.operation.read().status !== "pending") {
        return;
      }
      const errors: unknown[] = [];
      // Pool cancellation stops the worker, but an accepted host consumer still owns its data.
      let pending = pendingChunks > 0;
      for (const release of releases) {
        release.service();
        const outcome = release.read();
        pending ||= outcome.status === "pending";
        if (outcome.status === "rejected") {
          errors.push(outcome.error);
        }
      }
      if (pending) {
        return;
      }
      closing = undefined;
      try {
        throwSqliteLifecycleErrors(errors, "Shared-state reader task cleanup failed");
        completion.resolve(undefined);
      } catch (error) {
        completion.reject(error);
      }
    }
    for (const release of releases) {
      void release.result.then(
        () => completion.operation.service(),
        () => completion.operation.service(),
      );
    }
    completion.operation.service();
    return completion.operation;
  };
  return {
    startValidateFresh,
    startRead,
    startClose,
  };
}
