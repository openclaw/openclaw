import { AsyncLocalStorage } from "node:async_hooks";
import { stat } from "node:fs/promises";
import { getDatabaseProcessRole } from "../infra/database-engine/admission-scope.js";
import { getPostgresPool } from "../infra/postgres-sync/pool.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { acquireSqliteDatabaseAdmissionTurn } from "../infra/sqlite-database-admission-turn.js";
import { resolveSqliteDatabaseFilePath } from "../infra/sqlite-database-admission.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { assertDatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";
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

function decodeOpenClawStateReadReply(reply: OpenClawStateReadReply): OpenClawStateReadOutcome {
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

type ReadOperation = { close(): Promise<void> };
type ReadRuntime = {
  nativeSource: RetainedNativeWorkerSource;
  workerUrl: URL;
  operations: Set<ReadOperation>;
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
  // Long-lived hosts reuse their boot readers; one-shot inspection avoids a native supervisor.
  const retained =
    !awaitedOnly || state.pool !== undefined || getDatabaseProcessRole() === "gateway";
  const key = retained ? "pool" : "awaitedPool";
  if (!state[key]) {
    state[key] = createStateReadPool(state.workerUrl, retained ? state.nativeSource : undefined);
  }
  return { pool: state[key], retained };
}

/** Capture the execution source before snapshot preparation yields. */
export function captureOpenClawStateReadSource(): Pick<StateReadSource, "createTransport" | "own"> {
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
  return new StateReadSource(runtime);
}

class StateReadSource {
  private readonly admitted = new Set<ReadOperation>();

  constructor(readonly state: ReadRuntime) {}

  createTransport(
    command: OpenClawStateReadCommand,
    onChunk?: OpenClawStateReadOptions["onChunk"],
    onChunkAsync?: OpenClawStateReadOptions["onChunkAsync"],
    awaitedOnly = false,
  ): Pick<StateReadTransport, "startValidateFresh" | "startRead" | "startClose"> {
    return new StateReadTransport(command, this, onChunk, onChunkAsync, awaitedOnly);
  }

  ownsAdmission(): boolean {
    return this.admitted.size > 0;
  }

  own(close: () => Promise<void>): () => void {
    const { state, admitted } = this;
    if (state.sealed || state.closing) {
      throw new WorkerTaskError("Shared-state readers are closing", "unavailable");
    }
    const inContext = AsyncLocalStorage.snapshot();
    const operation: ReadOperation = {
      close: () => inContext(close),
    };
    state.operations.add(operation);
    admitted.add(operation);
    // A rejected result can still own failed cleanup. Only its owner releases it.
    return () => {
      state.operations.delete(operation);
      admitted.delete(operation);
    };
  }
}

type ReadTask = ReturnType<ReadPool["runTask"]>;

// Methods are shared; cancellation, command bytes, and failed cleanup remain per read.
class StateReadTransport {
  private readonly capturedCommand: OpenClawStateReadCommand;
  private readonly tasks = new Map<ReadTask, { retire: boolean }>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private pendingChunks = 0;
  private chunksDrained: (() => void) | undefined;

  constructor(
    command: OpenClawStateReadCommand,
    private readonly source: StateReadSource,
    private readonly onChunk?: OpenClawStateReadOptions["onChunk"],
    private readonly onChunkAsync?: OpenClawStateReadOptions["onChunkAsync"],
    private readonly awaitedOnly = false,
  ) {
    // Capture nested input before the read owner can yield during snapshot preparation.
    this.capturedCommand = structuredClone(command);
  }

  private async closeTask(task: ReadTask): Promise<void> {
    await task.close(this.tasks.get(task)?.retire ? { retire: true } : undefined);
    this.tasks.delete(task);
  }

  private startRun(
    context: OpenClawStateWorkerContext,
    location: string,
    checkFreshAdmission: boolean,
    readCommand: OpenClawStateReadRequest["command"],
    authority: OpenClawStateReadAuthority,
    expectedIdentity?: string,
    snapshotRoot?: string,
    postgresSnapshot?: string,
  ) {
    const { onChunk, onChunkAsync } = this;
    let releaseAdmission: (() => void) | undefined;
    const cleanup = { retire: true };
    try {
      if (this.closed) {
        throw new WorkerTaskError("Shared-state read transport is closed", "unavailable");
      }
      if (
        context.databaseEngineSelection &&
        Object.values(context.databaseEngineSelection.effectiveEngines).includes("postgres")
      ) {
        getPostgresPool();
      }
      const request: OpenClawStateReadRequest = {
        context: {
          databaseEngineSelection: context.databaseEngineSelection,
          environment: { ...context.environment },
          existingSchemaPath: context.existingSchemaPath,
          stateIntegrity: context.stateIntegrity,
        },
        databasePath: context.admission.databasePath,
        location,
        checkFreshAdmission,
        expectedIdentity,
        snapshotRoot,
        postgresSnapshot,
        command: { ...readCommand },
      };
      const pool = readPool(this.source.state, this.source.ownsAdmission(), this.awaitedOnly);
      // Maintenance reuses this reader; standalone inspection releases it before metadata loads.
      const retireAfterRead =
        !pool.retained && !context.maintenanceScope && readCommand.type !== "admit";
      const task = pool.pool.runTask(
        async () => {
          const physicalLocation = resolveSqliteDatabaseFilePath(location);
          const turn = acquireSqliteDatabaseAdmissionTurn(physicalLocation);
          if (turn) {
            releaseAdmission = await turn;
          }
          try {
            authority.assertCurrent();
            // Queue admission can outlive the captured file at this pathname.
            if (expectedIdentity !== undefined) {
              assertDatabaseFileIdentity(await stat(physicalLocation, { bigint: true }), {
                key: expectedIdentity,
              });
              authority.assertCurrent();
            }
            return request;
          } catch (error) {
            releaseAdmission?.();
            releaseAdmission = undefined;
            throw error;
          }
        },
        {
          signal: authority.signal,
          inputBytes: requestBytes(request),
          diagnosticOperation: readCommand.type,
          ...(onChunkAsync
            ? {
                onRequest: async (
                  value: unknown,
                  { signal: taskSignal }: { signal: AbortSignal },
                ) => {
                  authority.assertCurrent();
                  const signal = AbortSignal.any([authority.signal, taskSignal]);
                  signal.throwIfAborted();
                  this.pendingChunks += 1;
                  try {
                    await onChunkAsync(value, signal);
                    signal.throwIfAborted();
                    authority.assertCurrent();
                    return { input: null, timeoutMs: 300_000 };
                  } finally {
                    this.pendingChunks -= 1;
                    if (this.pendingChunks === 0) {
                      this.chunksDrained?.();
                    }
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
      this.tasks.set(task, cleanup);
      const result = (async (): Promise<OpenClawStateReadOutcome> => {
        let outcome: OpenClawStateReadOutcome;
        try {
          const reply = await task.result;
          cleanup.retire = retireAfterRead || Boolean(reply.nativeCleanupFailure);
          outcome = decodeOpenClawStateReadReply(reply);
        } catch (error) {
          outcome = { error };
        }
        releaseAdmission?.();
        releaseAdmission = undefined;
        // Native closes and quarantine cleanup can require exit even when the domain read succeeds.
        cleanup.retire ||= "error" in outcome;
        return outcome;
      })();
      return { task, result };
    } catch (error) {
      releaseAdmission?.();
      releaseAdmission = undefined;
      throw error;
    }
  }

  async startValidateFresh(
    context: OpenClawStateWorkerContext,
    authority: OpenClawStateReadAuthority,
  ): Promise<void> {
    const run = this.startRun(
      context,
      context.admission.databasePath,
      true,
      { type: "admit" },
      authority,
    );
    const read = await run.result;
    if ("error" in read) {
      throw read.error;
    }
    authority.assertCurrent();
    await this.closeTask(run.task);
  }
  async startRead(
    source: OpenClawStateReadLocation,
    authority: OpenClawStateReadAuthority,
  ): Promise<OpenClawStateReadOutcome> {
    return this.startRun(
      source.context,
      source.location,
      source.checkFreshAdmission,
      this.capturedCommand,
      authority,
      source.expectedIdentity,
      source.snapshotRoot,
      source.postgresSnapshot,
    ).result;
  }
  startClose(): Promise<void> {
    this.closed = true;
    if (this.closing) {
      return this.closing;
    }
    this.closing = (async () => {
      const releases = await Promise.allSettled(
        [...this.tasks.keys()].map((task) => this.closeTask(task)),
      );
      // Pool cancellation stops the worker, but an accepted host consumer still owns its data.
      if (this.pendingChunks > 0) {
        await new Promise<void>((resolve) => {
          this.chunksDrained = resolve;
        });
      }
      throwSqliteLifecycleErrors(
        releases.flatMap((release) => (release.status === "rejected" ? [release.reason] : [])),
        "Shared-state reader task cleanup failed",
      );
    })().finally(() => {
      this.chunksDrained = undefined;
      this.closing = undefined;
    });
    return this.closing;
  }
}
