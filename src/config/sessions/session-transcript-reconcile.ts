// Transcript projection reconciliation owner. Startup maintenance runs after ready;
// request paths may wait boundedly for their session's projection.
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToGateway, setTimeout as delay } from "node:timers/promises";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { computeBackoffSchedule } from "../../../packages/retry/src/index.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { isPathInside } from "../../infra/path-guards.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "../../state/agent-database-admission-error.js";
import {
  borrowOpenClawAgentDatabase,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "../../state/openclaw-agent-worker-store.js";
import { resolveStateDir } from "../paths.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import {
  withIncognitoProjection,
  captureIncognitoProjectionBinding,
  type IncognitoProjectionBinding,
  type IncognitoProjectionSource,
} from "./session-incognito-projection.js";
import { drainTranscriptIndexStatus } from "./session-transcript-index-maintenance.js";
import {
  deleteOrphanedTranscriptIndexRowsInTransaction,
  listSessionsNeedingTranscriptIndexReconcile,
} from "./session-transcript-index.js";
import type {
  ProjectionPublisher,
  TranscriptProjectionPublicationOperations,
} from "./session-transcript-projection-publication.worker.js";
import {
  appendPreparedProjectionChunk,
  claimPreparedSessionTranscriptProjection,
  finalizePreparedProjection,
  readTranscriptIndexBacklog,
  runProjectionWrite,
  type ActivePreparedProjection,
  type ReconcileDatabaseOptions,
} from "./session-transcript-projection-writer.js";
import { captureMemoryTranscriptProjectionSource } from "./session-transcript-reconcile-memory.js";
import {
  finishSessionTranscriptReconcileTask,
  isSessionTranscriptReconcileWorkerPoolClosing,
  runSessionTranscriptReconcileOperation,
  type SessionTranscriptReconcileOperation,
} from "./session-transcript-reconcile-pool.js";
import {
  prepareReconcileParams,
  readSessionTranscriptProjectionStatus,
  type PreparedReconcileParams,
  type SessionTranscriptReconcileParams,
} from "./session-transcript-reconcile-readiness.js";
import type {
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
} from "./session-transcript-reconcile.worker.js";

const log = createSubsystemLogger("sessions/transcript-index");
const PROJECTION_READY_POLL_MS = 10;
const RECONCILE_RETRY_BACKOFF_MS: readonly number[] = [0, 50, 200, 500, 1_000];
type RunningReconcile = {
  assertCurrent?: () => void;
  pending: boolean;
  signal?: AbortSignal;
  preferredSessionId?: string;
  promise?: Promise<SessionTranscriptReconcileResult>;
};

const runningReconciles = new Map<string, RunningReconcile>();

export type SessionTranscriptReconcileResult = {
  reconciledSessions: number;
};

type PreparedReconcileResult = SessionTranscriptReconcileResult & { pending: boolean };
type ReconcilePassResult = PreparedReconcileResult & { yielded: boolean };

function reconcileKey(
  params: OpenClawAgentDatabaseOptions,
  suppliedIncognito?: IncognitoProjectionBinding,
): string {
  const incognito = suppliedIncognito ?? captureIncognitoProjectionBinding(params);
  const path = resolveOpenClawAgentSqlitePath(params);
  return incognito
    ? `${path}#${JSON.stringify([incognito.actor.identity, incognito.target ?? null])}`
    : path;
}

/** Prepares full trees off-thread, then commits bounded chunks through the runtime writer owner. */
export async function reconcileSessionTranscriptIndexes(
  params: SessionTranscriptReconcileParams,
  incognito?: IncognitoProjectionBinding,
): Promise<SessionTranscriptReconcileResult> {
  if (getSessionActorStorageBinding({ ...params, storePath: params.path })) {
    return { reconciledSessions: 0 };
  }
  const prepared = prepareReconcileParams(params, incognito);
  const run = async () => {
    const execution =
      !prepared.incognito && supportsOpenClawAgentDatabaseExecution(prepared)
        ? captureOpenClawAgentDatabaseExecution(prepared)
        : undefined;
    try {
      const result = await runSessionTranscriptReconcileOperation(
        (operation) => reconcilePreparedTranscriptIndexes(prepared, operation, execution),
        prepared.incognito || isIncognitoOpenClawAgentSqlitePath(reconcileKey(prepared), prepared)
          ? undefined
          : { agentId: prepared.agentId, path: reconcileKey(prepared) },
        prepared.signal,
      );
      if (result.pending) {
        try {
          prepared.signal?.throwIfAborted();
          prepared.assertCurrent?.();
          execution?.assertCurrent();
          startPreparedSessionTranscriptIndexReconcile(prepared);
        } catch {
          // Refused continuation admission cannot replace acknowledged publication receipts.
          // The next owner rediscovers the remaining durable projection work.
        }
      }
      return { reconciledSessions: result.reconciledSessions };
    } finally {
      await execution?.release();
    }
  };
  const binding = prepared.incognito;
  return binding
    ? runOutsideAsyncWorkScope(() => binding.actor.sessions.withSharedState(run))
    : run();
}

async function reconcilePreparedTranscriptIndexes(
  params: PreparedReconcileParams,
  operation: SessionTranscriptReconcileOperation,
  execution?: OpenClawAgentDatabaseExecution,
): Promise<PreparedReconcileResult> {
  let reconciledSessions = 0;
  while (true) {
    operation.signal.throwIfAborted();
    const run = (source?: IncognitoProjectionSource) =>
      reconcilePreparedTranscriptIndexesPass(params, operation, execution, source);
    const result = await (params.incognito
      ? withIncognitoProjection(params.incognito, params, run)
      : run());
    reconciledSessions += result.reconciledSessions;
    if (!result.yielded) {
      return { reconciledSessions, pending: result.pending };
    }
  }
}

async function reconcilePreparedTranscriptIndexesPass(
  params: PreparedReconcileParams,
  operation: SessionTranscriptReconcileOperation,
  execution?: OpenClawAgentDatabaseExecution,
  actorSource?: IncognitoProjectionSource,
): Promise<ReconcilePassResult> {
  operation.signal.throwIfAborted();
  params.assertCurrent?.();
  const databasePath = resolveOpenClawAgentSqlitePath(params);
  const databaseOptions: ReconcileDatabaseOptions = {
    agentId: params.agentId,
    env: params.env,
    path: databasePath,
    assertCurrent: () => {
      operation.signal.throwIfAborted();
      params.assertCurrent?.();
    },
  };
  const assertCurrent = () => {
    databaseOptions.assertCurrent?.();
    execution?.assertCurrent();
  };
  let publicationClient:
    | OpenClawAgentSqliteWorkerStore<TranscriptProjectionPublicationOperations>
    | undefined;
  let publication: ProjectionPublisher | undefined;
  let releaseDatabase: (() => void) | undefined;
  const memorySource = actorSource
    ? undefined
    : captureMemoryTranscriptProjectionSource(databaseOptions);
  let sessionIds: string[];
  let pending = false;
  try {
    if (actorSource) {
      publication = actorSource.publication;
      sessionIds = actorSource.sessionIds;
      pending = actorSource.pending;
      if (sessionIds.length === 0) {
        return { reconciledSessions: 0, pending, yielded: false };
      }
    } else if (execution) {
      execution.assertCurrent();
      operation.signal.throwIfAborted();
      const client =
        await openOpenClawAgentSqliteWorkerStore<TranscriptProjectionPublicationOperations>(
          databaseOptions,
          { execution },
          {
            moduleUrl: resolveRuntimeWorkerUrl(
              runtimeProcessEntrypoints.sessionTranscriptProjectionPublication,
            ),
            input: undefined,
          },
        );
      publicationClient = client;
      publication = {
        execute: (command) => client.execute(command, assertCurrent, { signal: operation.signal }),
      };
      const status = await readTranscriptIndexBacklog(client, assertCurrent, operation.signal);
      sessionIds = status.sessionIds;
      pending = status.hasMore;
      if (sessionIds.length === 0) {
        return { reconciledSessions: 0, pending, yielded: false };
      }
    } else {
      operation.signal.throwIfAborted();
      sessionIds = await runProjectionWrite(
        databaseOptions,
        "sessions.transcript-index.preflight",
        (database) => {
          deleteOrphanedTranscriptIndexRowsInTransaction(database.db);
          const candidates = listSessionsNeedingTranscriptIndexReconcile(database.db);
          if (candidates.length > 0) {
            releaseDatabase = borrowOpenClawAgentDatabase(databaseOptions).release;
          }
          return candidates;
        },
        memorySource,
      );
      if (sessionIds.length === 0) {
        return { reconciledSessions: 0, pending, yielded: false };
      }
    }
    const preferred = params.preferredSessionId;
    if (preferred && sessionIds.includes(preferred)) {
      sessionIds = [preferred, ...sessionIds.filter((sessionId) => sessionId !== preferred)];
    }
    const input: SessionTranscriptReconcileWorkerInput =
      memorySource || actorSource
        ? { mode: "memory", sessionIds }
        : {
            mode: "disk",
            sessionIds,
            leaseId: randomUUID(),
            agentId: params.agentId,
            path: databasePath,
            stateDir: resolveStateDir(params.env),
            externallySupervised: isGatewayExternallySupervised(params.env),
          };
    const plannedSessionIds = new Set(sessionIds);
    const task = await operation.startTask(input);
    const worker = task.port;
    let handlingMessage: Promise<void> | undefined;
    let terminalReceived = false;
    let outcome: Result<ReconcilePassResult, unknown>;
    try {
      const value = await new Promise<ReconcilePassResult>((resolve, reject) => {
        let active: ActivePreparedProjection | undefined;
        let reconciledSessions = 0;
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          finish();
        };
        const handleMessage = async (
          message: Exclude<
            SessionTranscriptReconcileWorkerMessage,
            { type: "lease-released" | "lease-release-failed" }
          >,
        ) => {
          if (message.type === "failed") {
            terminalReceived = true;
            settle(() => reject(new Error(message.error)));
            return;
          }
          if (message.type === "done") {
            terminalReceived = true;
            if (active) {
              settle(() => reject(new Error("session transcript reconcile worker ended mid-plan")));
              return;
            }
            try {
              // Finalized receipts survive retirement before new cleanup admission.
              // A later preflight still detects and removes derived orphan rows.
              if (actorSource) {
                if (!operation.signal.aborted) {
                  const sweepPending = await actorSource.sweep?.();
                  pending ||= sweepPending ?? false;
                }
              } else if (publicationClient) {
                if (!operation.signal.aborted) {
                  const status = await drainTranscriptIndexStatus(() =>
                    publicationClient!.execute({ type: "sweep", input: undefined }, assertCurrent, {
                      signal: operation.signal,
                    }),
                  );
                  pending ||= status.hasMore || status.sessionIds.length > 0;
                }
              } else {
                await runProjectionWrite(
                  databaseOptions,
                  "sessions.transcript-index.orphan-sweep",
                  (database) => deleteOrphanedTranscriptIndexRowsInTransaction(database.db),
                  memorySource,
                );
              }
            } catch (error) {
              // Only a refused cleanup admission preserves earlier receipts; SQL failures still fail.
              if (
                !operation.signal.aborted ||
                error instanceof AggregateError ||
                (error !== operation.signal.reason &&
                  !(error instanceof AgentDatabaseExecutionAdmissionClosedError))
              ) {
                settle(() => reject(toStringifiedError(error)));
                return;
              }
            }
            settle(() => resolve({ reconciledSessions, pending, yielded: message.yielded }));
            return;
          }
          try {
            if (message.type === "source-read") {
              const source = actorSource ?? memorySource;
              if (!source || !plannedSessionIds.has(message.sessionId)) {
                throw new Error("session transcript worker requested an unavailable memory source");
              }
              const frame = await source.read(message.sessionId);
              await yieldToGateway();
              worker.postMessage(frame, frame.type === "source-frame" ? [frame.bytes.buffer] : []);
              return;
            }
            if (message.type === "plan-start") {
              if (active) {
                throw new Error("session transcript reconcile worker started overlapping plans");
              }
              active = await claimPreparedSessionTranscriptProjection(
                databaseOptions,
                message.plan,
                memorySource,
                publication,
              );
              worker.postMessage({ accepted: active !== undefined, type: "continue" }, []);
              return;
            }
            if (!active || active.plan.sessionId !== message.sessionId) {
              throw new Error(
                "session transcript reconcile worker sent a chunk for no active plan",
              );
            }
            if (message.type === "plan-finish") {
              const finalized = await finalizePreparedProjection(
                databaseOptions,
                active,
                memorySource,
                publication,
              );
              active = undefined;
              if (finalized) {
                reconciledSessions += 1;
              }
              worker.postMessage(
                {
                  accepted: finalized,
                  type: "continue",
                  ...(operation.shouldYield() ? { yield: true } : {}),
                },
                [],
              );
              return;
            }
            const owned = await appendPreparedProjectionChunk(
              databaseOptions,
              active,
              message.type === "active-chunk"
                ? { activeRows: message.rows }
                : { ftsChunk: message.chunk },
              memorySource,
              publication,
            );
            if (!owned) {
              active = undefined;
            }
            worker.postMessage({ accepted: owned, type: "continue" }, []);
          } catch (error) {
            settle(() => reject(toStringifiedError(error)));
          }
        };
        worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
          if (
            settled ||
            message.type === "lease-released" ||
            message.type === "lease-release-failed"
          ) {
            return;
          }
          handlingMessage = handleMessage(message);
        });
        worker.once("messageerror", (error) => {
          settle(() => reject(toStringifiedError(error)));
        });
        void task.completion.then(
          async () => {
            // Port closure follows its queued messages, unlike the pool's separate result port.
            await task.closed;
            if (!terminalReceived) {
              settle(() =>
                reject(new Error("session transcript worker task ended without a result")),
              );
            }
          },
          (error: unknown) => settle(() => reject(toStringifiedError(error))),
        );
      });
      outcome = ok(value);
    } catch (error) {
      outcome = err(error);
    }
    return await finishSessionTranscriptReconcileTask({
      operation,
      task,
      input,
      handlingMessage,
      terminalReceived,
      outcome,
    });
  } finally {
    memorySource?.clear();
    releaseDatabase?.();
    await publicationClient?.close();
  }
}

/** Starts one deferred reconcile. No transcript rows are read on the caller's stack. */
export function startSessionTranscriptIndexReconcile(
  input: SessionTranscriptReconcileParams,
  incognito?: IncognitoProjectionBinding,
): void {
  if (getSessionActorStorageBinding({ ...input, storePath: input.path })) {
    return;
  }
  startPreparedSessionTranscriptIndexReconcile(prepareReconcileParams(input, incognito));
}

function startPreparedSessionTranscriptIndexReconcile(params: PreparedReconcileParams): void {
  if (isSessionTranscriptReconcileWorkerPoolClosing()) {
    return;
  }
  const { incognito } = params;
  const key = reconcileKey(params, incognito);
  const running = runningReconciles.get(key);
  if (running) {
    // The active pass snapshots dirty sessions. Latch later writes so it
    // rescans before ownership is released instead of losing their work.
    running.pending = true;
    running.preferredSessionId ??= params.preferredSessionId;
    return;
  }
  const state: RunningReconcile = {
    pending: false,
    ...(params.preferredSessionId ? { preferredSessionId: params.preferredSessionId } : {}),
  };
  // Capture the memory owner before yielding so disposal cannot reopen its sentinel.
  const memorySource = incognito ? undefined : captureMemoryTranscriptProjectionSource(params);
  state.assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    incognito?.actor.assertCurrent();
    incognito?.authority.assertCurrent();
  };
  const accepted = runSessionTranscriptReconcileOperation(
    async (operation) => {
      const execution =
        !incognito && supportsOpenClawAgentDatabaseExecution(params)
          ? captureOpenClawAgentDatabaseExecution(params)
          : undefined;
      state.signal = operation.signal;
      try {
        await yieldToGateway();
        let reconciledSessions = 0;
        let retryCount = 0;
        do {
          operation.signal.throwIfAborted();
          memorySource?.assertCurrentOwner();
          state.assertCurrent?.();
          state.pending = false;
          const pass = { ...params, preferredSessionId: state.preferredSessionId };
          delete state.preferredSessionId;
          const reconcile = () => reconcilePreparedTranscriptIndexes(pass, operation, execution);
          const result = await (incognito ? runOutsideAsyncWorkScope(reconcile) : reconcile());
          reconciledSessions += result.reconciledSessions;
          state.pending ||= result.pending;
          // Sustained writes can outpace rebuilding; bound the repeated parsing cost (#115908).
          if (state.pending) {
            await delay(computeBackoffSchedule(RECONCILE_RETRY_BACKOFF_MS, ++retryCount));
          }
        } while (state.pending);
        // New work gets its own operation while the completed one releases its resources.
        runningReconciles.delete(key);
        return { reconciledSessions };
      } finally {
        await execution?.release();
      }
    },
    incognito || isIncognitoOpenClawAgentSqlitePath(key, params)
      ? undefined
      : { agentId: params.agentId, path: key },
    params.signal,
  );
  const pending = accepted
    .catch((error: unknown) => {
      // Failed background work is rediscovered by the next request or restart.
      log.warn(
        `session transcript reconcile failed agent=${params.agentId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return { reconciledSessions: 0 };
    })
    .finally(() => {
      if (runningReconciles.get(key) === state) {
        runningReconciles.delete(key);
      }
    });
  state.promise = incognito ? incognito.actor.sessions.withSharedState(() => pending) : pending;
  runningReconciles.set(key, state);
}

export function isSessionTranscriptIndexReconcileRunning(
  params: OpenClawAgentDatabaseOptions,
  incognito?: IncognitoProjectionBinding,
): boolean {
  if (getSessionActorStorageBinding({ ...params, storePath: params.path })) {
    return false;
  }
  return runningReconciles.has(reconcileKey(params, incognito));
}

/** Test and maintenance wait hook for an already-scheduled reconcile. */
export async function waitForSessionTranscriptIndexReconcile(
  params: OpenClawAgentDatabaseOptions,
  incognito?: IncognitoProjectionBinding,
): Promise<void> {
  if (getSessionActorStorageBinding({ ...params, storePath: params.path })) {
    return;
  }
  await runningReconciles.get(reconcileKey(params, incognito))?.promise;
}

/** Test and maintenance drain for scheduled reconciles owned by one state directory. */
export async function waitForSessionTranscriptIndexReconcilesInStateDir(
  stateDir: string,
): Promise<void> {
  while (true) {
    const owners = [...runningReconciles]
      .filter(([databasePath]) => isPathInside(stateDir, databasePath))
      .flatMap(([, owner]) => (owner.promise ? [owner.promise] : []));
    if (owners.length === 0) {
      return;
    }
    // Handoffs and other fixture databases may register owners while this batch settles.
    await Promise.all(owners);
  }
}

/** Waits only until the requested session's scheduled projection rebuild settles. */
export async function waitForSessionTranscriptProjection(
  scope: SessionTranscriptReadScope,
  abortSignal?: AbortSignal,
  incognito?: IncognitoProjectionBinding,
): Promise<void> {
  if (getSessionActorStorageBinding(scope)) {
    abortSignal?.throwIfAborted();
    return;
  }
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = prepareReconcileParams(toDatabaseOptions(resolved), incognito);
  const wait = () =>
    waitForPreparedSessionTranscriptProjection(resolved.sessionId, databaseOptions, abortSignal);
  return databaseOptions.incognito
    ? databaseOptions.incognito.actor.sessions.withSharedState(wait)
    : wait();
}

async function waitForPreparedSessionTranscriptProjection(
  sessionId: string,
  databaseOptions: PreparedReconcileParams,
  abortSignal?: AbortSignal,
): Promise<void> {
  const { incognito } = databaseOptions;
  const key = reconcileKey(databaseOptions, incognito);
  let running = runningReconciles.get(key);
  if (!running) {
    return;
  }
  const needsReconcile = () =>
    readSessionTranscriptProjectionStatus(databaseOptions, sessionId, abortSignal);
  try {
    while (running) {
      abortSignal?.throwIfAborted();
      // Revoked work retains its close fence until settlement. Do not admit a reader
      // or recreate a disposed incognito owner while that fence is held.
      if (!running.signal?.aborted) {
        running.assertCurrent?.();
        if (!(await needsReconcile())) {
          return;
        }
      }
      await delay(
        PROJECTION_READY_POLL_MS,
        undefined,
        abortSignal ? { signal: abortSignal } : undefined,
      );
      running = runningReconciles.get(key);
    }
  } catch (error) {
    // Worker reads settle before exposing the same cancellation shape as polling.
    if (abortSignal?.aborted && error === abortSignal.reason) {
      throw createAbortError("Operation aborted", { cause: error });
    }
    throw error;
  }
}
