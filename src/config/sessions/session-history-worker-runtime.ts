import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import { prepareGatewaySessionStoreReadSources } from "../../gateway/session-utils-store-sources.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../../infra/worker-task-capacity.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { getRuntimeConfig } from "../config.js";
import type { SessionTranscriptReadScope } from "./session-accessor.js";
import type { SessionTranscriptDisplayDeltaResult } from "./session-accessor.sqlite-history-query.js";
import {
  resolveSqliteTranscriptReadScope,
  resolveSqliteScope,
  toDatabaseOptions,
  type SessionSqliteTargetResolutionCache,
} from "./session-accessor.sqlite-scope.js";
import { prepareSessionTranscriptReadTargetCore } from "./session-accessor.transcript-read-target.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import type {
  ChatHistoryPage,
  SessionHistorySnapshot,
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "./session-history-types.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import type { SessionTranscriptHistoryWorkerInput } from "./session-transcript-worker.types.js";

type QueuedHistoryRead = {
  promise: Promise<SessionHistoryWorkerResult>;
  remainingReaders: number;
};
const queuedHistoryReads = new Map<string, QueuedHistoryRead>();
let pendingHistoryReaders = 0;
let pendingHistoryBytes = 0;

function receivePage(
  queued: QueuedHistoryRead,
  signal?: AbortSignal,
): Promise<SessionHistoryWorkerResult> {
  queued.remainingReaders++;
  return queued.promise.then((page) => {
    queued.remainingReaders--;
    signal?.throwIfAborted();
    // Dispatch closes the group; the final receiver owns the original after earlier clones finish.
    return queued.remainingReaders === 0 ? page : structuredClone(page);
  });
}

function readQueuedPage(
  input: SessionTranscriptHistoryWorkerInput,
  key: string,
  owner: SessionHistoryWorkerDatabase,
  signal?: AbortSignal,
): Promise<SessionHistoryWorkerResult> {
  signal?.throwIfAborted();
  const existing = queuedHistoryReads.get(key);
  if (existing) {
    return receivePage(existing, signal);
  }
  const pending = createDeferredCore<SessionHistoryWorkerResult>();
  const queued = { promise: pending.promise, remainingReaders: 0 };
  queuedHistoryReads.set(key, queued);
  void owner
    .run(() => {
      // A later caller must not join a SQLite snapshot that has already started.
      queuedHistoryReads.delete(key);
      return input;
    }, key.length * 2)
    .then(pending.resolve, pending.reject)
    .finally(() => {
      if (queuedHistoryReads.get(key) === queued) {
        queuedHistoryReads.delete(key);
      }
    });
  return receivePage(queued, signal);
}

export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "rpc" }>,
  signal?: AbortSignal,
): Promise<ChatHistoryPage>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "http" }>,
  signal?: AbortSignal,
): Promise<SessionHistorySnapshot>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "delta" }>,
  signal?: AbortSignal,
): Promise<SessionTranscriptDisplayDeltaResult>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "message-lookup" }>,
  signal?: AbortSignal,
): Promise<unknown[]>;
export async function readSessionHistoryPageInWorker(
  request: SessionHistoryWorkerRequest,
  signal?: AbortSignal,
): Promise<
  ChatHistoryPage | SessionHistorySnapshot | SessionTranscriptDisplayDeltaResult | unknown[]
> {
  signal?.throwIfAborted();
  const scope: SessionTranscriptReadScope =
    request.kind === "rpc"
      ? {
          agentId: request.params.sessionAgentId,
          sessionId: request.params.sessionId,
          sessionEntry: request.params.entry,
          sessionKey: request.params.canonicalKey,
          storePath: request.params.storePath,
        }
      : request.params.target;
  const targetCache: SessionSqliteTargetResolutionCache = new Map();
  const resolved = resolveSqliteTranscriptReadScope(scope, targetCache);
  const admission = resolveSessionTranscriptReadFence(resolved);
  const bound = prepareSessionTranscriptReadTargetCore(scope);
  const entryValidationKey = bound.entryValidationScope
    ? resolveSqliteScope(bound.entryValidationScope, targetCache).sessionKey
    : undefined;
  const sessionKey = entryValidationKey ?? bound.sessionKey;
  const transcript = {
    agentId: bound.agentId,
    sessionId: scope.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    storePath: bound.storePath,
  };
  const readScope = resolveSqliteTranscriptReadScope(transcript, targetCache);
  const databaseOptions = toDatabaseOptions(resolved);
  const currentSource = {
    agentId: databaseOptions.agentId,
    path: resolveOpenClawAgentSqlitePath(databaseOptions),
  };
  const stateContext = captureOpenClawStateWorkerContext();
  const sourceReads = prepareGatewaySessionStoreReadSources({
    cfg: getRuntimeConfig(),
    currentSource,
    env: process.env,
    registryPath: stateContext.admission.databasePath,
  });
  const assertStateCurrent = () => {
    stateContext.maintenanceScope?.assertAdmission();
    stateContext.admission.assertCurrent();
    sourceReads.assertCurrent();
  };
  assertStateCurrent();
  const target: Omit<PreparedSessionHistoryReadTarget, "database"> = {
    transcript: {
      agentId: readScope.agentId,
      sessionId: scope.sessionId,
      ...(readScope.sessionKey ? { sessionKey: readScope.sessionKey } : {}),
      storePath: bound.storePath,
      // Projection/fence identity is normalized; archive and presentation hints retain their input.
      sessionFile: sessionKey ?? scope.sessionId,
    },
    stateDatabase: {
      path: stateContext.admission.databasePath,
      environment: stateContext.environment,
      coordinatorRuntime: stateContext.coordinatorRuntime,
    },
    sourceDatabases: sourceReads.sources,
    ...(entryValidationKey ? { entryValidationKey } : {}),
  };

  const input: SessionTranscriptHistoryWorkerInput = {
    kind: "history-page",
    database: currentSource,
    request,
    target,
    ...(admission ? { admission: { ...admission } } : {}),
  };
  const key = JSON.stringify(input);
  const inputBytes = key.length * 2;
  // Coalescing bounds execution, but every retained caller still needs admission.
  if (
    pendingHistoryReaders >= DEFAULT_WORKER_PENDING_TASKS ||
    pendingHistoryBytes + inputBytes > DEFAULT_WORKER_PENDING_BYTES
  ) {
    throw new WorkerTaskError("worker task capacity reached", "overloaded");
  }
  pendingHistoryReaders++;
  pendingHistoryBytes += inputBytes;
  try {
    const result = await withSessionHistoryWorkerDatabase(input.database, (owner) =>
      readRestoredSessionTranscript(
        scope,
        () => {
          assertStateCurrent();
          return readQueuedPage(input, `${owner.generation}:${key}`, owner, signal);
        },
        { assertCurrent: owner.assertCurrent },
      ),
    );
    assertStateCurrent();
    if (result.kind !== request.kind) {
      throw new Error("Session history worker returned the wrong page type");
    }
    return result.kind === "rpc"
      ? result.page
      : result.kind === "http"
        ? result.snapshot
        : result.kind === "delta"
          ? result.delta
          : result.messages;
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      startSessionTranscriptIndexReconcile({
        ...databaseOptions,
        preferredSessionId: resolved.sessionId,
      });
    }
    throw error;
  } finally {
    pendingHistoryReaders--;
    pendingHistoryBytes -= inputBytes;
  }
}
