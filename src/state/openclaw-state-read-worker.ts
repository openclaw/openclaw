import { AsyncLocalStorage } from "node:async_hooks";
import {
  ensureSqliteLibrarySelected,
  getSqliteRuntimeCapabilities,
} from "../infra/bun-sqlite-library.js";
import {
  createRetainedOperation,
  flatMapRetainedOperation,
  type RetainedOperation,
} from "../infra/retained-operation.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import {
  captureRetainedNativeWorkerSource,
  type RetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../infra/worker-task-capacity.js";
import { createOwnedWorkerTaskPool, WorkerTaskError } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";
import { captureCommand, requestBytes } from "./openclaw-state-read-request.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadCommand,
  OpenClawStateReadLocation,
  OpenClawStateReadOutcome,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

type ReadPool = ReturnType<
  typeof createOwnedWorkerTaskPool<OpenClawStateReadRequest, OpenClawStateReadReply>
>;
type ReadOperation = { service(): void; close(): Promise<void> };
type ReadRuntime = {
  nativeSource: RetainedNativeWorkerSource;
  workerUrl: URL;
  operations: Set<ReadOperation>;
  servicing: boolean;
  sealed: boolean;
  pool?: ReadPool;
  closing?: Promise<void>;
  stopping?: Promise<void>;
};

function closeReadResources(pool: ReadPool | undefined, key?: string) {
  if (!pool) {
    return undefined;
  }
  return getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources
    ? pool.closeResources(key)
    : pool.rotate();
}

async function closeReadPool(state: ReadRuntime): Promise<void> {
  if (state.closing) {
    return await state.closing;
  }
  const pool = state.pool;
  if (!pool) {
    return;
  }
  const closing = Promise.resolve()
    .then(() => closeReadResources(pool))
    .then(() => pool.close())
    .then(() => {
      state.pool = undefined;
    });
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
              await closeReadResources(state.pool, identity.key);
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
        for (const state of sources.values()) {
          void closeReadResources(state.pool, event.identity.key)?.catch((error: unknown) => {
            // The worker retains failed cleanup; canonical path close retries it.
            process.emitWarning(`Shared-state reader invalidation failed: ${String(error)}`);
          });
        }
      }
    });
    return sources;
  });
}

function readPool(state: ReadRuntime, admitted: boolean): ReadPool {
  // Accepted owners may still need a final read while generation admission is sealed.
  if ((state.sealed && !admitted) || state.closing) {
    throw new WorkerTaskError("Shared-state readers are closing", "unavailable");
  }
  if (!state.pool) {
    // Library selection precedes worker creation; each worker inherits its current close fact.
    ensureSqliteLibrarySelected();
    state.pool = createOwnedWorkerTaskPool(
      {
        workerUrl: state.workerUrl,
        workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
        maxWorkers: 2,
        idleTimeoutMs: SQLITE_IDLE_HANDLE_TTL_MS,
        maxPendingTasks: DEFAULT_WORKER_PENDING_TASKS,
        maxPendingBytes: DEFAULT_WORKER_PENDING_BYTES,
      },
      { retainedTransport: true, nativeSource: state.nativeSource },
    );
  }
  return state.pool;
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
    createTransport: (command: OpenClawStateReadCommand) =>
      createReadTransport(command, state, () => admitted.size > 0),
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

function decodeTaskReply(reply: OpenClawStateReadReply): OpenClawStateReadOutcome {
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

function createReadTransport(
  command: OpenClawStateReadCommand,
  state: ReadRuntime,
  ownsAdmission: () => boolean,
) {
  // Capture nested input before the read owner can yield during snapshot preparation.
  const capturedCommand = captureCommand(command);
  type ReadTask = ReturnType<ReadPool["startTask"]>;
  const tasks = new Map<ReadTask, { retire: boolean; error?: Error }>();
  let closed = false;
  let closing: RetainedOperation<void> | undefined;

  const startCloseTask = (task: ReadTask): RetainedOperation<void> => {
    const inContext = AsyncLocalStorage.snapshot();
    const cleanup = tasks.get(task);
    let release: RetainedOperation<void>;
    const completion = createRetainedOperation<void>(() => inContext(service));
    const fail = (error: unknown) =>
      completion.reject(
        cleanup?.error
          ? createSqliteLifecycleAggregateError(
              [cleanup.error, error],
              "Shared-state reader cleanup and worker retirement failed",
              cleanup.error,
            )
          : error,
      );
    function service() {
      if (completion.operation.read().status !== "pending") {
        return;
      }
      try {
        release.service();
        const outcome = release.read();
        if (outcome.status === "pending") {
          return;
        }
        if (outcome.status === "rejected") {
          throw outcome.error;
        }
        tasks.delete(task);
        completion.resolve(undefined);
      } catch (error) {
        fail(error);
      }
    }
    try {
      release = task.release(cleanup?.retire ? { retire: true } : undefined);
      void release.result.then(
        () => completion.operation.service(),
        () => completion.operation.service(),
      );
      completion.operation.service();
    } catch (error) {
      fail(error);
    }
    return completion.operation;
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
    const cleanup: { retire: boolean; error?: Error } = { retire: true };
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
        if (reply.nativeCleanupFailure) {
          const error = new Error("Shared-state reader native cleanup was not confirmed");
          retainOpenClawStateWorkerErrorPayload(error, reply.nativeCleanupFailure.error);
          cleanup.error = hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
        }
        outcome = decodeTaskReply(reply);
      } catch (error) {
        outcome = { error };
      }
      // Native closes and quarantine cleanup can require exit even when the domain read succeeds.
      cleanup.retire = "error" in outcome || cleanup.error !== undefined;
      completion.resolve(outcome);
    }
    try {
      if (closed) {
        throw new WorkerTaskError("Shared-state read transport is closed", "unavailable");
      }
      const request: OpenClawStateReadRequest = {
        context: {
          environment: { ...context.environment },
          existingSchemaPath: context.existingSchemaPath,
        },
        databasePath: context.admission.databasePath,
        location,
        checkFreshAdmission,
        expectedIdentity,
        snapshotRoot,
        command: { ...readCommand },
      };
      task = readPool(state, ownsAdmission()).startTask(
        () => {
          authority.assertCurrent();
          return request;
        },
        { signal: authority.signal, inputBytes: requestBytes(request) },
      );
      tasks.set(task, cleanup);
      void task.result.then(
        () => completion.operation.service(),
        () => completion.operation.service(),
      );
      completion.operation.service();
    } catch (error) {
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
      let pending = false;
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
