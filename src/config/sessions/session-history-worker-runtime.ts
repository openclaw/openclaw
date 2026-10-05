import path from "node:path";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import { prepareGatewaySessionStoreReadSourcesAsync } from "../../gateway/session-utils-store-sources.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../../infra/worker-task-capacity.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { getRuntimeConfig } from "../config.js";
import { getCliSessionBinding } from "./cli-session-binding.js";
import type { SessionTranscriptReadScope } from "./session-accessor.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { prepareSessionTranscriptReadTargetCore } from "./session-accessor.transcript-read-target.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import type {
  SessionHistoryDelta,
  SessionHistorySubagentFacts,
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "./session-history-types.js";
import { SessionHistoryDeltaPreparationError } from "./session-history-worker-errors.js";
import type {
  SessionColdMetadataWorkerInput,
  SessionColdMetadataWorkerResult,
} from "./session-transcript-inventory.types.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import type { SessionTranscriptHistoryWorkerInput } from "./session-transcript-worker.types.js";
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
      if (queued.remainingReaders === 0) {
        return page;
      }
      if (page.kind === "rpc" && page.page.encodedResponse) {
        // Wire bytes are immutable; each reader still owns its mutable page metadata.
        const { messages, ...response } = page.page.encodedResponse;
        const copy = structuredClone({
          ...page,
          page: { ...page.page, encodedResponse: response },
        });
        return {
          ...copy,
          page: { ...copy.page, encodedResponse: { ...copy.page.encodedResponse, messages } },
        };
      }
      return structuredClone(page);
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
      : owner.run(
          () => {
            // Page callers cannot join a SQLite snapshot that has already started.
            forget();
            return input;
          },
          key.length * 2 +
            (input.kind === "history-page" &&
            (input.request.kind === "rpc" || input.request.kind === "rpc-message")
              ? (input.request.params.cliHistoryRedaction?.retainedBytes ?? 0)
              : 0),
        );
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
  if (request.kind !== "rpc" && request.kind !== "rpc-message" && request.kind !== "http") {
    const target = request.params.target;
    const capturedTarget = {
      ...target,
      sessionEntry: target.sessionEntry ? { sessionId: target.sessionEntry.sessionId } : undefined,
      ...(target.env ? { env: captureSessionTranscriptStorageEnvironment(target.env) } : {}),
    };
    if (request.kind === "summary") {
      return {
        kind: request.kind,
        params: { target: capturedTarget, query: structuredClone(request.params.query) },
      };
    }
    if (request.kind === "artifacts") {
      return {
        kind: request.kind,
        params: { target: capturedTarget, query: structuredClone(request.params.query) },
      };
    }
    if (request.kind === "inline-visibility") {
      return {
        kind: request.kind,
        params: { target: capturedTarget, lookup: { ...request.params.lookup } },
      };
    }
    const captureOptions = <T>(options: T) => ({
      target: capturedTarget,
      options: structuredClone(options),
    });
    if (request.kind === "active-accounting") {
      return { kind: request.kind, params: captureOptions(request.params.options) };
    }
    if (request.kind === "bounded-tail") {
      return { kind: request.kind, params: captureOptions(request.params.options) };
    }
    if (request.kind === "message-page") {
      return { kind: request.kind, params: captureOptions(request.params.options) };
    }
    if (request.kind === "around-id") {
      return { kind: request.kind, params: captureOptions(request.params.options) };
    }
    if (request.kind === "source-messages") {
      return { kind: request.kind, params: captureOptions(request.params.options) };
    }
    if (request.kind === "recent-page") {
      return {
        kind: request.kind,
        params: {
          target: capturedTarget,
          ...(request.params.exactArchivePath
            ? { exactArchivePath: path.resolve(request.params.exactArchivePath) }
            : {}),
          options: structuredClone(request.params.options),
        },
      };
    }
    if (request.kind === "conversation-binding") {
      return {
        kind: request.kind,
        params: { target: capturedTarget, conversationRef: request.params.conversationRef },
      };
    }
    if (
      request.kind === "transcript-binding" ||
      request.kind === "message-count" ||
      request.kind === "reactions"
    ) {
      return { kind: request.kind, params: { target: capturedTarget } };
    }
    if (request.kind === "message-by-id") {
      return {
        kind: request.kind,
        params: {
          target: capturedTarget,
          messageId: request.params.messageId,
          options: request.params.options ? structuredClone(request.params.options) : undefined,
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
  const entry = request.kind === "http" ? request.params.target.sessionEntry : request.params.entry;
  const cliBinding = getCliSessionBinding(entry, "claude-cli");
  const capturedEntry = entry
    ? {
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt,
        sessionStartedAt: entry.sessionStartedAt,
        ...(cliBinding
          ? { cliSessionBindings: { "claude-cli": structuredClone(cliBinding) } }
          : {}),
      }
    : undefined;
  if (request.kind === "rpc" || request.kind === "rpc-message") {
    const params = request.params;
    const captured = {
      encodeResponse: params.encodeResponse,
      compactionMetrics: params.compactionMetrics?.map((metric) => ({ ...metric })),
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
      cliHistoryHomeDir: params.cliHistoryHomeDir,
      ...(params.cliHistoryRedaction
        ? { cliHistoryRedaction: structuredClone(params.cliHistoryRedaction) }
        : {}),
    };
    return request.kind === "rpc-message"
      ? { kind: "rpc-message", params: { ...captured, messageId: request.params.messageId } }
      : { kind: "rpc", params: captured };
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

type SessionHistoryPageValue<Result> = Result extends { result: infer Value }
  ? Value
  : Result extends { binding: infer Value }
    ? Value
    : Result extends { page: infer Value }
      ? Value
      : Result extends { snapshot: infer Value }
        ? Value
        : Result extends { count: infer Value }
          ? Value
          : Result extends { messages: infer Value }
            ? Value
            : Result extends { kind: "delta" }
              ? AdmittedSessionHistoryDelta
              : Result extends { kind: "inline-visibility" }
                ? { subagentCoordination: SessionHistorySubagentFacts; assertCurrent: () => void }
                : never;

type SessionHistoryPageValues = {
  [Result in SessionHistoryWorkerResult as Result["kind"]]: SessionHistoryPageValue<Result>;
};

export function readSessionHistoryPageInWorker<Request extends SessionHistoryWorkerRequest>(
  request: Request,
  signal?: AbortSignal,
): Promise<SessionHistoryPageValues[Request["kind"]]>;
export async function readSessionHistoryPageInWorker(
  request: SessionHistoryWorkerRequest,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const capturedRequest = captureHistoryRequest(request);
  const scope: SessionTranscriptReadScope =
    capturedRequest.kind === "rpc" || capturedRequest.kind === "rpc-message"
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
  const redaction =
    capturedRequest.kind === "rpc" || capturedRequest.kind === "rpc-message"
      ? capturedRequest.params.cliHistoryRedaction
      : undefined;
  const keyedRequest =
    (capturedRequest.kind === "rpc" || capturedRequest.kind === "rpc-message") && redaction
      ? {
          ...capturedRequest,
          params: {
            ...capturedRequest.params,
            cliHistoryRedaction: { policyToken: redaction.policyToken },
          },
        }
      : capturedRequest;
  const redactionBytes = redaction?.retainedBytes ?? 0;
  let inputBytes = JSON.stringify(keyedRequest).length * 2 + redactionBytes;
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
    const resolved = await prepareSqliteTranscriptReadScope(capturedScope, signal);
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
      // Only display-history projections resolve subagent lineage across stores.
      const sourceReads =
        capturedRequest.kind === "rpc" ||
        capturedRequest.kind === "rpc-message" ||
        capturedRequest.kind === "http" ||
        capturedRequest.kind === "delta" ||
        capturedRequest.kind === "inline-visibility"
          ? await prepareGatewaySessionStoreReadSourcesAsync({
              cfg,
              currentSource,
              env,
              registryPath: stateContext.admission.databasePath,
            })
          : undefined;
      const primaryPath = sourceReads ? undefined : createOpenClawAgentDatabasePathMatcher();
      primaryPath?.(currentSource.path, currentSource.path);
      const assertStateCurrent = () => {
        signal?.throwIfAborted();
        stateContext.maintenanceScope?.assertAdmission();
        stateContext.admission.assertCurrent();
        sourceReads?.assertSourceCurrent();
        if (primaryPath && !primaryPath.isCurrent()) {
          throw new Error("Session store changed while preparing its metadata. Retry the request.");
        }
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
        },
        ...(sourceReads?.request
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
      const key = JSON.stringify({ ...input, request: keyedRequest });
      const metadataInput: SessionColdMetadataWorkerInput = {
        kind: "cold-metadata",
        database: currentSource,
        sessionId: preparedTarget.sessionId,
        env,
      };
      const metadataKey = JSON.stringify(metadataInput);
      const additionalBytes = (key.length + metadataKey.length) * 2 + redactionBytes - inputBytes;
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
      const exactArchiveRead =
        capturedRequest.kind === "recent-page" &&
        capturedRequest.params.exactArchivePath !== undefined;
      const readOnly =
        capturedRequest.kind === "active-accounting" || capturedRequest.kind === "bounded-tail"
          ? true
          : capturedRequest.kind === "artifacts"
            ? capturedRequest.params.query.kind === "image-page"
            : exactArchiveRead
              ? true
              : capturedRequest.kind === "message-page" ||
                  capturedRequest.kind === "around-id" ||
                  capturedRequest.kind === "source-messages" ||
                  capturedRequest.kind === "recent-page"
                ? capturedRequest.params.options.readOnly
                : false;
      let retriedProjection = false;
      const readPage = () => readQueuedHistory(input, `${owner.generation}:${key}`, owner, signal);
      try {
        if (exactArchiveRead) {
          const page = await readPage();
          if (page.kind === "cold-metadata") {
            throw new Error("Session history worker returned cold metadata instead of history");
          }
          result = page;
        } else {
          result = await readRestoredSessionTranscript(
            capturedScope,
            async () => {
              assertCurrent();
              let page: ForegroundHistoryResult;
              try {
                page = await readPage();
              } catch (error) {
                if (
                  (capturedRequest.kind === "active-accounting" ||
                    (capturedRequest.kind === "bounded-tail" &&
                      !capturedRequest.params.options.readOnly)) &&
                  isSessionTranscriptProjectionUnavailableError(error)
                ) {
                  assertCurrent();
                  startSessionTranscriptIndexReconcile({
                    ...databaseOptions,
                    preferredSessionId: preparedTarget.sessionId,
                  });
                }
                if (
                  readOnly ||
                  retriedProjection ||
                  !isSessionTranscriptProjectionUnavailableError(error) ||
                  error.reason !== "rebuilding"
                ) {
                  throw error;
                }
                assertCurrent();
                retriedProjection = true;
                startSessionTranscriptIndexReconcile({
                  ...databaseOptions,
                  preferredSessionId: preparedTarget.sessionId,
                });
                const deadline = new AbortController();
                const timer = setTimeout(() => deadline.abort(error), 3_000);
                timer.unref();
                try {
                  await waitForSessionTranscriptProjection(
                    capturedScope,
                    signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
                  );
                } catch (waitError) {
                  assertCurrent();
                  if (
                    waitError === error ||
                    (waitError instanceof Error &&
                      waitError.name === "AbortError" &&
                      waitError.cause === error)
                  ) {
                    throw error;
                  }
                  throw waitError;
                } finally {
                  clearTimeout(timer);
                }
                assertCurrent();
                page = await readPage();
              }
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
                      : await owner.readColdMetadata({
                          sessionId: metadataInput.sessionId,
                          env,
                        });
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
        }
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
      await sourceReads?.revalidate(() => {
        owner.assertCurrent();
        assertStateCurrent();
      });
      return {
        result,
        assertCurrent: () => {
          owner.assertCurrent();
          assertStateCurrent();
          sourceReads?.assertCurrent();
        },
      };
    });
    const { assertCurrent, result } = acquired;
    assertCurrent();
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
    if (result.kind === "inline-visibility") {
      return { subagentCoordination: result.subagentCoordination, assertCurrent };
    }
    return result.kind === "rpc"
      ? result.page
      : result.kind === "http"
        ? result.snapshot
        : result.kind === "message-count"
          ? result.count
          : result.messages;
  } finally {
    pendingHistoryReaders--;
    pendingHistoryBytes -= inputBytes;
  }
}
