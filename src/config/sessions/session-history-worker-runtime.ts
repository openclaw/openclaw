import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../../infra/worker-task-capacity.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SessionTranscriptReadScope } from "./session-accessor.js";
import {
  type ResolvedTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionColdPreparationResult,
  SessionColdReadPreparation,
} from "./session-cold-storage-preparation.js";
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
  runSessionHistoryWorkerRequest,
  runSessionColdPreparationWorkerRequest,
} from "./session-transcript-worker-runtime.js";
import type {
  SessionColdPreparationWorkerInput,
  SessionTranscriptHistoryWorkerInput,
} from "./session-transcript.worker.js";

type ForegroundHistoryResult = SessionHistoryWorkerResult | SessionColdPreparationResult;
type QueuedHistoryRead = {
  promise: Promise<ForegroundHistoryResult>;
  shared: boolean;
  registryGeneration?: symbol;
};
const queuedHistoryReads = new Map<string, QueuedHistoryRead>();
let pendingHistoryReaders = 0;
let pendingHistoryBytes = 0;

function receivePage(
  queued: QueuedHistoryRead,
  signal?: AbortSignal,
): Promise<ForegroundHistoryResult> {
  return queued.promise.then((page) => {
    signal?.throwIfAborted();
    return queued.shared ? structuredClone(page) : page;
  });
}

function readQueuedHistoryRequest(
  input: SessionTranscriptHistoryWorkerInput | SessionColdPreparationWorkerInput,
  key: string,
  signal?: AbortSignal,
  registryGeneration?: symbol,
): Promise<ForegroundHistoryResult> {
  signal?.throwIfAborted();
  const existing = queuedHistoryReads.get(key);
  if (existing && existing.registryGeneration === registryGeneration) {
    existing.shared = true;
    return receivePage(existing, signal);
  }
  const pending = createDeferredCore<ForegroundHistoryResult>();
  const queued = { promise: pending.promise, shared: false, registryGeneration };
  queuedHistoryReads.set(key, queued);
  const forget = () => {
    if (queuedHistoryReads.get(key) === queued) {
      queuedHistoryReads.delete(key);
    }
  };
  const operation =
    input.kind === "history-page"
      ? runSessionHistoryWorkerRequest(() => {
          // Page callers cannot join a SQLite snapshot that has already started.
          forget();
          return input;
        }, key.length * 2)
      : runSessionColdPreparationWorkerRequest(input.request);
  // Only the initial probe shares an in-flight result. The atomic page read detects
  // newly cold rows, and each queued restore performs its own fresh metadata reread.
  void operation.then(
    (result) => {
      forget();
      pending.resolve(result);
    },
    (error: unknown) => {
      forget();
      pending.reject(error);
    },
  );
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
export async function readSessionHistoryPageInWorker(
  request: SessionHistoryWorkerRequest,
  signal?: AbortSignal,
): Promise<ChatHistoryPage | SessionHistorySnapshot> {
  signal?.throwIfAborted();
  const scope: SessionTranscriptReadScope =
    request.kind === "rpc"
      ? {
          agentId: request.params.sessionAgentId,
          sessionId: request.params.sessionId,
          sessionKey: request.params.canonicalKey,
          storePath: request.params.storePath,
        }
      : request.params.target;
  let resolved: ResolvedTranscriptReadScope | undefined;
  let inputBytes = JSON.stringify(request).length * 2;
  // Coalescing bounds execution, but every retained caller still needs admission.
  if (
    pendingHistoryReaders >= DEFAULT_WORKER_PENDING_TASKS ||
    pendingHistoryBytes + inputBytes > DEFAULT_WORKER_PENDING_BYTES
  ) {
    throw new WorkerTaskError("worker task capacity reached", "overloaded");
  }
  pendingHistoryReaders++;
  pendingHistoryBytes += inputBytes;
  const prepareColdRead: SessionColdReadPreparation = async (preparation, registryGeneration) => {
    const input: SessionColdPreparationWorkerInput = {
      kind: "cold-preparation",
      request: preparation,
    };
    const key = JSON.stringify(input);
    const preparationBytes = key.length * 2;
    if (pendingHistoryBytes + preparationBytes > DEFAULT_WORKER_PENDING_BYTES) {
      throw new WorkerTaskError("worker task capacity reached", "overloaded");
    }
    pendingHistoryBytes += preparationBytes;
    try {
      const result = await readQueuedHistoryRequest(input, key, signal, registryGeneration);
      if (!("target" in result)) {
        throw new Error("Session history worker returned a page instead of preparation");
      }
      return result;
    } finally {
      pendingHistoryBytes -= preparationBytes;
    }
  };
  try {
    const result = await readRestoredSessionTranscript(
      scope,
      (target) => {
        if (!target) {
          throw new Error("Session history preparation returned no resolved target");
        }
        resolved = target;
        const admission = resolveSessionTranscriptReadFence(target);
        const input: SessionTranscriptHistoryWorkerInput = {
          kind: "history-page",
          request:
            request.kind === "rpc"
              ? {
                  ...request,
                  params: {
                    ...request.params,
                    storePath: target.path,
                    sessionAgentId: target.agentId,
                    canonicalKey: target.sessionKey ?? request.params.canonicalKey,
                  },
                }
              : {
                  ...request,
                  params: {
                    ...request.params,
                    target: {
                      ...request.params.target,
                      storePath: target.path,
                      agentId: target.agentId,
                      sessionKey: target.sessionKey ?? request.params.target.sessionKey,
                    },
                  },
                },
          registrySnapshot: target.registrySnapshot,
          ...(admission ? { admission: { ...admission } } : {}),
        };
        const key = JSON.stringify(input);
        const additionalBytes = key.length * 2 - inputBytes;
        if (pendingHistoryBytes + additionalBytes > DEFAULT_WORKER_PENDING_BYTES) {
          throw new WorkerTaskError("worker task capacity reached", "overloaded");
        }
        pendingHistoryBytes += additionalBytes;
        inputBytes += additionalBytes;
        return readQueuedHistoryRequest(input, key, signal);
      },
      { prepareColdRead },
    );
    if ("target" in result || result.kind !== request.kind) {
      throw new Error("Session history worker returned the wrong page type");
    }
    return result.kind === "rpc" ? result.page : result.snapshot;
  } catch (error) {
    if (resolved && isSessionTranscriptProjectionUnavailableError(error)) {
      startSessionTranscriptIndexReconcile({
        ...toDatabaseOptions(resolved),
        preferredSessionId: resolved.sessionId,
      });
    }
    throw error;
  } finally {
    pendingHistoryReaders--;
    pendingHistoryBytes -= inputBytes;
  }
}
