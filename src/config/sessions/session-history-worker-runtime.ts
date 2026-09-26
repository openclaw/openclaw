import path from "node:path";
import type { SessionArtifactReadResult } from "../../gateway/session-artifact-read.js";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import type {
  ReadRecentSessionMessagesResult,
  ReadSessionMessageByIdResult,
  ReadSessionMessagesAroundIdResult,
  ReadSessionMessagesResult,
} from "../../gateway/session-transcript-read-kernel.js";
import { prepareGatewaySessionStoreReadSourcesAsync } from "../../gateway/session-utils-store-sources.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../../infra/worker-task-capacity.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { getRuntimeConfig } from "../config.js";
import type { SessionTranscriptReadScope } from "./session-accessor.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import { prepareSessionTranscriptReadTargetCore } from "./session-accessor.transcript-read-target.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import type {
  ChatHistoryPage,
  SessionHistoryDelta,
  SessionHistoryTranscriptBinding,
  SessionHistorySnapshot,
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "./session-history-types.js";
import { SessionHistoryDeltaPreparationError } from "./session-history-worker-errors.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import type {
  SessionColdMetadataWorkerInput,
  SessionColdMetadataWorkerResult,
  SessionTranscriptHistoryWorkerInput,
} from "./session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

type ForegroundHistoryResult = SessionHistoryWorkerResult | SessionColdMetadataWorkerResult;

type QueuedHistoryRead = {
  promise: Promise<ForegroundHistoryResult>;
  remainingReaders: number;
};
type AdmittedSessionHistoryDelta = SessionHistoryDelta & { assertCurrent: () => void };
const queuedHistoryReads = new Map<string, QueuedHistoryRead>();
let pendingHistoryReaders = 0;
let pendingHistoryBytes = 0;

function receivePage(
  queued: QueuedHistoryRead,
  signal?: AbortSignal,
): Promise<ForegroundHistoryResult> {
  queued.remainingReaders++;
  return queued.promise.then(
    (page) => {
      queued.remainingReaders--;
      signal?.throwIfAborted();
      // Dispatch closes the group; the final receiver owns the original after earlier clones finish.
      return queued.remainingReaders === 0 ? page : structuredClone(page);
    },
    (error: unknown) => {
      queued.remainingReaders--;
      if (error instanceof SessionHistoryDeltaPreparationError) {
        signal?.throwIfAborted();
        if (queued.remainingReaders > 0) {
          throw new SessionHistoryDeltaPreparationError(structuredClone(error.partial));
        }
      }
      throw error;
    },
  );
}

function readQueuedHistory(
  input: SessionTranscriptHistoryWorkerInput | SessionColdMetadataWorkerInput,
  key: string,
  owner: SessionHistoryWorkerDatabase,
  signal?: AbortSignal,
): Promise<ForegroundHistoryResult> {
  signal?.throwIfAborted();
  const existing = queuedHistoryReads.get(key);
  if (existing) {
    return receivePage(existing, signal);
  }
  const pending = createDeferredCore<ForegroundHistoryResult>();
  const queued = { promise: pending.promise, remainingReaders: 0 };
  queuedHistoryReads.set(key, queued);
  const forget = () => {
    if (queuedHistoryReads.get(key) === queued) {
      queuedHistoryReads.delete(key);
    }
  };
  const operation =
    input.kind === "cold-metadata"
      ? owner.readColdMetadata({ sessionId: input.sessionId, env: input.env })
      : owner.run(() => {
          // Page callers cannot join a SQLite snapshot that has already started.
          forget();
          return input;
        }, key.length * 2);
  // Initial metadata probes share only in-flight work; queued restores bypass this map.
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

function captureHistoryRequest(request: SessionHistoryWorkerRequest): SessionHistoryWorkerRequest {
  if (request.kind !== "rpc" && request.kind !== "http") {
    const target = request.params.target;
    const capturedTarget = {
      ...target,
      sessionEntry: target.sessionEntry ? { sessionId: target.sessionEntry.sessionId } : undefined,
      ...(target.env ? { env: captureSessionTranscriptStorageEnvironment(target.env) } : {}),
    };
    if (request.kind === "artifacts") {
      return {
        kind: request.kind,
        params: { target: capturedTarget, query: structuredClone(request.params.query) },
      };
    }
    if (request.kind === "message-page") {
      return {
        kind: request.kind,
        params: { target: capturedTarget, options: structuredClone(request.params.options) },
      };
    }
    if (request.kind === "around-id") {
      return {
        kind: request.kind,
        params: { target: capturedTarget, options: structuredClone(request.params.options) },
      };
    }
    if (request.kind === "source-messages") {
      return {
        kind: request.kind,
        params: { target: capturedTarget, options: structuredClone(request.params.options) },
      };
    }
    if (request.kind === "recent-page") {
      return {
        kind: request.kind,
        params: { target: capturedTarget, options: structuredClone(request.params.options) },
      };
    }
    if (request.kind === "transcript-binding") {
      return {
        kind: request.kind,
        params: {
          target: capturedTarget,
          run: request.params.run ? { ...request.params.run } : undefined,
        },
      };
    }
    if (request.kind === "message-count") {
      return { kind: request.kind, params: { target: capturedTarget } };
    }
    if (request.kind === "message-by-id") {
      return {
        kind: request.kind,
        params: {
          target: capturedTarget,
          messageId: request.params.messageId,
          options: request.params.options ? { ...request.params.options } : undefined,
        },
      };
    }
    if (request.kind === "recent") {
      return {
        kind: "recent",
        params: {
          target: capturedTarget,
          maxMessages: request.params.maxMessages,
          maxLines: request.params.maxLines,
          allowResetArchiveFallback: request.params.allowResetArchiveFallback,
        },
      };
    }
    return request.kind === "delta"
      ? { kind: "delta", params: { target: capturedTarget, limits: { ...request.params.limits } } }
      : {
          kind: "message-lookup",
          params: { target: capturedTarget, messageId: request.params.messageId },
        };
  }
  const entry = request.kind === "rpc" ? request.params.entry : request.params.target.sessionEntry;
  const capturedEntry = entry
    ? {
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt,
        sessionStartedAt: entry.sessionStartedAt,
      }
    : undefined;
  if (request.kind === "rpc") {
    const params = request.params;
    return {
      kind: "rpc",
      params: {
        entry: capturedEntry,
        provider: params.provider,
        sessionId: params.sessionId,
        storePath: params.storePath,
        sessionAgentId: params.sessionAgentId,
        canonicalKey: params.canonicalKey,
        max: params.max,
        maxHistoryBytes: params.maxHistoryBytes,
        effectiveMaxChars: params.effectiveMaxChars,
        offset: params.offset,
        messageId: params.messageId,
        ignoreCliSessionImports: params.ignoreCliSessionImports,
      },
    };
  }
  const params = request.params;
  return {
    kind: "http",
    params: {
      target: {
        agentId: params.target.agentId,
        sessionEntry: capturedEntry,
        sessionId: params.target.sessionId,
        sessionKey: params.target.sessionKey,
        storePath: params.target.storePath,
        ...(params.target.env
          ? { env: captureSessionTranscriptStorageEnvironment(params.target.env) }
          : {}),
      },
      maxChars: params.maxChars,
      limit: params.limit,
      cursor: params.cursor,
    },
  };
}

export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "artifacts" }>,
  signal?: AbortSignal,
): Promise<SessionArtifactReadResult>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "message-page" | "recent-page" }>,
  signal?: AbortSignal,
): Promise<ReadRecentSessionMessagesResult>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "around-id" }>,
  signal?: AbortSignal,
): Promise<ReadSessionMessagesAroundIdResult>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "source-messages" }>,
  signal?: AbortSignal,
): Promise<ReadSessionMessagesResult>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "transcript-binding" }>,
  signal?: AbortSignal,
): Promise<SessionHistoryTranscriptBinding | undefined>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "message-by-id" }>,
  signal?: AbortSignal,
): Promise<ReadSessionMessageByIdResult>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "message-count" }>,
  signal?: AbortSignal,
): Promise<number>;
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
): Promise<AdmittedSessionHistoryDelta>;
export function readSessionHistoryPageInWorker(
  request: Extract<SessionHistoryWorkerRequest, { kind: "message-lookup" | "recent" }>,
  signal?: AbortSignal,
): Promise<unknown[]>;
export async function readSessionHistoryPageInWorker(
  request: SessionHistoryWorkerRequest,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const capturedRequest = captureHistoryRequest(request);
  const scope: SessionTranscriptReadScope =
    capturedRequest.kind === "rpc"
      ? {
          agentId: capturedRequest.params.sessionAgentId,
          sessionId: capturedRequest.params.sessionId,
          sessionEntry: capturedRequest.params.entry,
          sessionKey: capturedRequest.params.canonicalKey,
          storePath: capturedRequest.params.storePath,
        }
      : capturedRequest.params.target;
  const env = captureSessionTranscriptStorageEnvironment(scope.env ?? process.env);
  const bound = prepareSessionTranscriptReadTargetCore(scope);
  const capturedScope = {
    ...scope,
    agentId: bound.agentId,
    storePath: path.resolve(bound.storePath),
    env,
  };
  const stateContext = captureOpenClawStateWorkerContext({ env });
  const cfg = getRuntimeConfig();
  const receipt = resolveSessionTranscriptReadFence({
    agentId: normalizeAgentId(bound.agentId),
    sessionId: scope.sessionId,
  });
  const admission = receipt ? { ...receipt } : undefined;
  let resolved: ResolvedTranscriptReadScope | undefined;
  let inputBytes = JSON.stringify(capturedRequest).length * 2;
  // Retain caller admission across asynchronous target discovery as well as the page read.
  if (
    pendingHistoryReaders >= DEFAULT_WORKER_PENDING_TASKS ||
    pendingHistoryBytes + inputBytes > DEFAULT_WORKER_PENDING_BYTES
  ) {
    throw new WorkerTaskError("worker task capacity reached", "overloaded");
  }
  pendingHistoryReaders++;
  pendingHistoryBytes += inputBytes;
  try {
    resolved = await prepareSqliteTranscriptReadScope(capturedScope, signal);
    signal?.throwIfAborted();
    stateContext.maintenanceScope?.assertAdmission();
    stateContext.admission.assertCurrent();
    // Key normalization needs no second store discovery after the physical target is prepared.
    const entryValidationKey = bound.entryValidationScope
      ? resolveSqliteScope({
          agentId: resolved.agentId,
          sessionKey: bound.entryValidationScope.sessionKey,
        }).sessionKey
      : undefined;
    const sessionKey = entryValidationKey ?? bound.sessionKey;
    const normalizedSessionKey = entryValidationKey ?? resolved.sessionKey;
    const databaseOptions = toDatabaseOptions(resolved);
    const currentSource = {
      agentId: databaseOptions.agentId,
      path: resolveOpenClawAgentSqlitePath(databaseOptions),
    };
    const preparedTarget = resolved;
    const acquired = await withSessionHistoryWorkerDatabase(databaseOptions, async (owner) => {
      const sourceReads = await prepareGatewaySessionStoreReadSourcesAsync({
        cfg,
        currentSource,
        env,
        registryPath: stateContext.admission.databasePath,
      });
      const assertStateCurrent = () => {
        signal?.throwIfAborted();
        stateContext.maintenanceScope?.assertAdmission();
        stateContext.admission.assertCurrent();
        sourceReads.assertSourceCurrent();
      };
      assertStateCurrent();
      const target: Omit<PreparedSessionHistoryReadTarget, "database"> = {
        transcript: {
          agentId: preparedTarget.agentId,
          sessionId: preparedTarget.sessionId,
          ...(normalizedSessionKey ? { sessionKey: normalizedSessionKey } : {}),
          storePath: capturedScope.storePath,
          sessionFile: sessionKey ?? preparedTarget.sessionId,
        },
        stateDatabase: {
          path: stateContext.admission.databasePath,
          environment: stateContext.environment,
          coordinatorRuntime: stateContext.coordinatorRuntime,
        },
        ...(sourceReads.request
          ? { sourceDiscovery: sourceReads.request }
          : { sourceDatabases: {} }),
        ...(entryValidationKey ? { entryValidationKey } : {}),
      };
      const input: SessionTranscriptHistoryWorkerInput = {
        kind: "history-page",
        database: currentSource,
        request: capturedRequest,
        target,
        ...(admission ? { admission } : {}),
      };
      const key = JSON.stringify(input);
      const metadataInput: SessionColdMetadataWorkerInput = {
        kind: "cold-metadata",
        database: currentSource,
        sessionId: preparedTarget.sessionId,
        env,
      };
      const metadataKey = JSON.stringify(metadataInput);
      const additionalBytes = (key.length + metadataKey.length) * 2 - inputBytes;
      if (pendingHistoryBytes + additionalBytes > DEFAULT_WORKER_PENDING_BYTES) {
        throw new WorkerTaskError("worker task capacity reached", "overloaded");
      }
      pendingHistoryBytes += additionalBytes;
      inputBytes += additionalBytes;
      const assertCurrent = () => {
        owner.assertCurrent();
        assertStateCurrent();
      };
      let result: SessionHistoryWorkerResult;
      const readOnly =
        capturedRequest.kind === "artifacts"
          ? capturedRequest.params.query.kind === "image-page"
          : capturedRequest.kind === "message-page" ||
              capturedRequest.kind === "around-id" ||
              capturedRequest.kind === "source-messages" ||
              capturedRequest.kind === "recent-page"
            ? capturedRequest.params.options.readOnly
            : false;
      try {
        result = await readRestoredSessionTranscript(
          capturedScope,
          async () => {
            assertCurrent();
            const page = await readQueuedHistory(
              input,
              `${owner.generation}:${key}`,
              owner,
              signal,
            );
            if (page.kind === "cold-metadata") {
              throw new Error("Session history worker returned cold metadata instead of history");
            }
            return page;
          },
          {
            readOnly,
            assertCurrent,
            coldRead: {
              target: preparedTarget,
              readMetadata: async (phase) => {
                assertCurrent();
                const metadata =
                  phase === "initial"
                    ? await readQueuedHistory(
                        metadataInput,
                        `${owner.generation}:${metadataKey}`,
                        owner,
                        signal,
                      )
                    : await owner.readColdMetadata({ sessionId: metadataInput.sessionId, env });
                assertCurrent();
                if (metadata.kind !== "cold-metadata") {
                  throw new Error(
                    "Session history worker returned history instead of cold metadata",
                  );
                }
                return metadata.archive;
              },
            },
          },
        );
      } catch (error) {
        if (
          error instanceof SessionHistoryDeltaPreparationError &&
          capturedRequest.kind === "delta"
        ) {
          // Failed execution/retirement has joined. Recover inside the retained
          // scope so primary revocation and release failures still refuse it.
          owner.assertCurrent();
          result = { kind: "delta", ...error.partial };
        } else {
          throw error;
        }
      }
      await sourceReads.revalidate(() => {
        owner.assertCurrent();
        assertStateCurrent();
      });
      return {
        result,
        assertCurrent: () => {
          owner.assertCurrent();
          assertStateCurrent();
          sourceReads.assertCurrent();
        },
      };
    });
    const assertCurrent = () => acquired.assertCurrent();
    assertCurrent();
    const result = acquired.result;
    if (result.kind !== capturedRequest.kind) {
      throw new Error("Session history worker returned the wrong page type");
    }
    if (result.kind === "transcript-binding") {
      return result.binding;
    }
    if ("result" in result) {
      return result.result;
    }
    if (result.kind === "delta") {
      const delta: AdmittedSessionHistoryDelta = { ...result, assertCurrent };
      return delta;
    }
    return result.kind === "rpc"
      ? result.page
      : result.kind === "http"
        ? result.snapshot
        : result.kind === "message-count"
          ? result.count
          : result.messages;
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
