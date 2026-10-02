import { decodeAgentDatabaseReaderRequest } from "../../infra/agent-database-readers.js";
import type {
  UsageCostWorkerInput,
  UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import { serveOwnedWorkerTasks } from "../../infra/worker-task-server.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import type { SessionIdentityEvidenceResult } from "./session-accessor.sqlite-entry-availability.js";
import {
  isSessionHistoryReadOperation,
  prepareSessionHistoryReadOperation,
} from "./session-history-read-operation.worker.js";
import {
  encodeSessionTranscriptWorkerError,
  encodeSessionTranscriptRequestError,
} from "./session-history-worker-errors.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  withHistoryDatabase,
  pruneClosedHistoryDatabaseScopes,
} from "./session-transcript-worker-scopes.js";
import type {
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerReply,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

let releaseReadValidation:
  | typeof import("../../state/openclaw-agent-db-validation-cache.js").releaseOpenClawAgentDatabaseReadValidation
  | undefined;

serveOwnedWorkerTasks(
  async (
    input,
    channel,
    control,
  ): Promise<
    SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues> | UsageCostWorkerReply
  > => {
    // Install cleanup before this worker can acquire either a cached or explicit reader.
    releaseReadValidation ??= (await import("../../state/openclaw-agent-db-validation-cache.js"))
      .releaseOpenClawAgentDatabaseReadValidation;
    // SAFETY: The paired runtime constructs this request; the SQLite snapshot validates admission.
    const request = input as SessionTranscriptWorkerInput | UsageCostWorkerInput;
    if (request.kind === "sqlite-target") {
      const { resolveSqliteTargetFromSessionStorePath } =
        await import("./session-sqlite-target.js");
      return {
        ok: true,
        value: { target: resolveSqliteTargetFromSessionStorePath(request.storePath, request) },
      };
    }
    if (request.kind === "usage-cost") {
      const { executeUsageCostWorker, usageCostWorkerFailure } =
        await import("../../infra/session-cost-usage-worker.js");
      try {
        if (!channel) {
          throw new Error("Usage cost worker requires its host channel");
        }
        const closed = new Map<string, UsageCostWorkerInput["databases"][number]>();
        const value = await executeUsageCostWorker(
          request,
          channel,
          control,
          async (database, read) => {
            closed.delete(JSON.stringify(database));
            const result = await withHistoryDatabase(database, request.kind, read);
            if (result.closedHistoryDatabase) {
              closed.set(
                JSON.stringify(result.closedHistoryDatabase),
                result.closedHistoryDatabase,
              );
            }
            return result.value;
          },
        );
        return { ok: true, value, closedDatabases: [...closed.values()] };
      } catch (error) {
        return usageCostWorkerFailure(error);
      }
    }
    const readRequest = async (): Promise<
      SessionTranscriptWorkerValues[keyof SessionTranscriptWorkerValues]
    > => {
      if (isSessionHistoryReadOperation(request)) {
        const execute = await prepareSessionHistoryReadOperation(request);
        return execute();
      }
      if (request.kind === "lifecycle-artifact-plan") {
        const { readSessionLifecycleArtifactCleanup } =
          await import("./session-accessor.sqlite-lifecycle-artifacts.js");
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            readSessionLifecycleArtifactCleanup(database, request.input, request.expectedSource),
          { ...request.database, env: request.env },
        );
        return {
          kind: request.kind,
          plan: result.found ? result.value : { entries: [], deletePlans: [] },
          diagnostics: request.input.diagnostics,
        };
      }
      if (request.kind === "prewarm") {
        await Promise.all([
          import("../../gateway/session-history-worker-reader.js"),
          import("../../gateway/server-methods/chat-history-page-kernel.js"),
          import("../../gateway/server-methods/chat-history-response-page.js"),
          import("../../gateway/session-history-snapshot.js"),
        ]);
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const opened = withOpenClawAgentDatabaseReadOnly(() => undefined, {
          ...request.database,
          env: cloneEnvWithPlatformSemantics(request.env),
        });
        if (!opened.found && opened.reason !== "database-missing") {
          throw new Error(`Session history prewarm admission unavailable: ${opened.reason}`);
        }
        return { kind: "prewarm" as const };
      }
      if (request.kind === "historical-eviction-candidates") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { runSqliteDeferredTransactionSync } =
          await import("../../infra/sqlite-transaction.js");
        const {
          readHistoricalSessionIdsInDatabase,
          readDiskEvictableArchivedSessionBatchInDatabase,
        } = await import("./session-history-eviction-candidates.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            runSqliteDeferredTransactionSync(database.db, () =>
              "archived" in request
                ? {
                    batch: readDiskEvictableArchivedSessionBatchInDatabase(
                      database,
                      request.archived,
                    ),
                  }
                : { sessionIds: readHistoricalSessionIdsInDatabase({ ...request, database }) },
            ),
          { ...request.database, env: request.env },
        );
        if (!result.found) {
          if ("archived" in request && result.reason === "database-missing") {
            return {
              kind: "historical-eviction-candidates",
              batch: { candidates: [], exhausted: true },
            };
          }
          throw new Error(`SQLite history eviction cannot read its database: ${result.reason}`);
        }
        return { kind: "historical-eviction-candidates" as const, ...result.value };
      }
      if (request.kind === "session-pending-archives") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { runSqliteDeferredTransactionSync } =
          await import("../../infra/sqlite-transaction.js");
        const { hasPendingSessionTranscriptArchives } =
          await import("./session-accessor.sqlite-archive-store-kernel.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            runSqliteDeferredTransactionSync(database.db, () =>
              hasPendingSessionTranscriptArchives(database),
            ),
          { ...request.database, env: cloneEnvWithPlatformSemantics(request.env) },
        );
        return {
          kind: "session-pending-archives" as const,
          pending: result.found && result.value,
        };
      }
      if (request.kind === "memory-session-targets") {
        const { readMemorySessionTargets } = await import("./session-memory-targets.js");
        return {
          kind: request.kind,
          targets: readMemorySessionTargets(
            { ...request.params, env: cloneEnvWithPlatformSemantics(request.params.env) },
            request.continuation,
          ),
        };
      }
      if (request.kind === "session-archive-inventory") {
        const { listSessionTranscriptArchivesReadOnly } =
          await import("./session-accessor.sqlite-history.js");
        return {
          kind: request.kind,
          archives: listSessionTranscriptArchivesReadOnly({
            ...request,
            env: cloneEnvWithPlatformSemantics(request.env ?? process.env),
          }),
        };
      }
      if (request.kind === "session-corpus-inventory") {
        const { readSessionTranscriptCorpusInventory } =
          await import("../../../packages/memory-host-sdk/src/host/session-transcript-corpus.js");
        return {
          kind: request.kind,
          entries: readSessionTranscriptCorpusInventory(
            { ...request.scope, env: cloneEnvWithPlatformSemantics(request.scope.env) },
            request.options,
            request.artifacts,
            request.database.path,
            request.continuation,
          ),
        };
      }
      if (request.kind === "session-archive-presence") {
        const { readTranscriptArchivePresenceInWorker } =
          await import("./session-accessor.sqlite-archive-read.js");
        return {
          kind: "session-archive-presence" as const,
          registered: readTranscriptArchivePresenceInWorker({
            ...request,
            env: cloneEnvWithPlatformSemantics(request.env),
          }),
        };
      }
      if (request.kind === "session-archive-pruning") {
        const { readSessionArchivePruningInWorker } =
          await import("./session-history-archive-pruning.worker.js");
        return {
          kind: "session-archive-pruning" as const,
          result: readSessionArchivePruningInWorker(request),
        };
      }
      if (request.kind === "cold-metadata" || request.kind === "cold-storage-inventory") {
        const cold = await import("./session-cold-storage-worker.js");
        const options = { ...request.database, env: cloneEnvWithPlatformSemantics(request.env) };
        return request.kind === "cold-metadata"
          ? {
              kind: request.kind,
              archive: cold.readSessionColdMetadataInWorker(options, request.sessionId),
            }
          : { kind: request.kind, ...cold.readSessionColdStorageInventoryInWorker(options) };
      }
      if (request.kind === "session-store-target") {
        const { readSessionStoreTargetResult } =
          await import("./session-store-target-inventory.js");
        request.request.env = cloneEnvWithPlatformSemantics(request.request.env);
        const read = readSessionStoreTargetResult(request.request);
        if (!read.ok) {
          const readError = encodeSessionTranscriptWorkerError(read.error);
          if (!readError) {
            throw read.error;
          }
          return { kind: "session-store-target", readError };
        }
        return read.value;
      }
      if (request.kind === "session-exact-entries") {
        const { readExactSessionEntriesWithLifecycle } =
          await import("./session-entry-read.worker.js");
        request.env = cloneEnvWithPlatformSemantics(request.env);
        return readExactSessionEntriesWithLifecycle(request);
      }
      if (request.kind === "session-row-facts") {
        const { readSessionRowDatabaseFacts } = await import("./session-entry-read.worker.js");
        return readSessionRowDatabaseFacts(request);
      }
      if (request.kind === "session-entry-current") {
        const { readSessionEntryCurrentFacts } = await import("./session-entry-read.worker.js");
        return readSessionEntryCurrentFacts(request);
      }
      if (request.kind === "session-row-backfill") {
        const { readSessionRowTranscriptFields } =
          await import("../../gateway/session-row-transcript-backfill.kernel.js");
        return {
          kind: "session-row-backfill" as const,
          fields: readSessionRowTranscriptFields(request.params),
        };
      }
      if (request.kind === "session-target-inventory") {
        const { readSessionStoreTargetInventory } =
          await import("./session-store-target-inventory.js");
        return readSessionStoreTargetInventory(request.request);
      }
      if (request.kind === "session-identity-evidence") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { readSessionIdentityEvidenceInDatabase } =
          await import("./session-accessor.sqlite-entry-availability.js");
        const { readWithCanonicalSessionReaderContinuation } =
          await import("./session-canonical-key.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            readWithCanonicalSessionReaderContinuation(database, request.continuation, () =>
              readSessionIdentityEvidenceInDatabase(database, request.identities),
            ),
          { ...request.database, env: cloneEnvWithPlatformSemantics(request.env) },
        );
        const evidence: SessionIdentityEvidenceResult[] = result.found
          ? result.value
          : request.identities.map(() =>
              result.reason === "database-missing"
                ? { status: "absent" }
                : { status: "unknown", reason: result.reason },
            );
        return { kind: "session-identity-evidence" as const, evidence };
      }
      if (request.kind === "session-diagnostic-text") {
        const { readSessionDiagnosticText } = await import("./session-entry-read.worker.js");
        return readSessionDiagnosticText(request);
      }
      if (request.kind === "session-entry-read" || request.kind === "session-runtime-target") {
        const { readSessionEntryWorkerRequest } = await import("./session-entry-read.worker.js");
        return readSessionEntryWorkerRequest(request);
      }
      if (request.kind === "session-entry-list") {
        const { readSessionEntryList } = await import("./session-entry-read.worker.js");
        return {
          kind: "session-entry-list" as const,
          entries: readSessionEntryList(request),
        };
      }
      if (request.kind === "session-store-summary") {
        const { readSessionStoreSummaryReadOnly } =
          await import("./session-accessor.sqlite-summary.js");
        return {
          kind: "session-store-summary" as const,
          summary: readSessionStoreSummaryReadOnly(
            {
              agentId: request.database.agentId,
              storePath: request.database.path,
              env: cloneEnvWithPlatformSemantics(request.env),
            },
            request,
          ),
        };
      }
      if (request.kind === "usage-cache") {
        const { readSessionCostUsageCache } =
          await import("../../infra/session-cost-usage-cache-read.js");
        return readSessionCostUsageCache(
          { ...request.database, env: request.env },
          request.request,
        );
      }
      if (request.kind === "session-membership-facts") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { readSessionMembershipFactsInDatabase } =
          await import("./session-membership-facts.js");
        const { readWithCanonicalSessionReaderContinuation } =
          await import("./session-canonical-key.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            readWithCanonicalSessionReaderContinuation(database, request.continuation, () =>
              readSessionMembershipFactsInDatabase(database, request.sessionKeys),
            ),
          { ...request.database, env: cloneEnvWithPlatformSemantics(request.env) },
        );
        if (!result.found && result.reason !== "database-missing") {
          throw new Error(`Session membership read unavailable: ${result.reason}`);
        }
        return result.found
          ? result.value
          : { kind: "session-membership-facts" as const, facts: [] };
      }
      if (request.kind === "projection-status") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { runSqliteDeferredTransactionSync } =
          await import("../../infra/sqlite-transaction.js");
        const {
          hasSessionsNeedingTranscriptIndexReconcile,
          hasOrphanedTranscriptIndexRows,
          sessionTranscriptIndexNeedsReconcile,
        } = await import("./session-transcript-index.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          ({ db }) =>
            runSqliteDeferredTransactionSync(db, () =>
              request.sessionId !== undefined
                ? sessionTranscriptIndexNeedsReconcile(db, request.sessionId)
                : hasSessionsNeedingTranscriptIndexReconcile(db) ||
                  hasOrphanedTranscriptIndexRows(db),
            ),
          { ...request.database, env: request.env },
        );
        return result.found
          ? result.value
          : request.sessionId === undefined && result.reason === "schema-missing";
      }
      if (request.kind === "session-members") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { listSessionMembersInDatabase } = await import("./session-sharing-store.kernel.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) => listSessionMembersInDatabase(database, request.sessionKey),
          { ...request.database, env: request.env },
        );
        return result.found ? result.value : [];
      }
      if (request.kind === "session-suggestions") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { listSessionSuggestionsInDatabase } =
          await import("./session-suggestion-store.kernel.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            listSessionSuggestionsInDatabase(database, request.sessionKey, request.params),
          { ...request.database, env: request.env },
        );
        return {
          kind: "session-suggestions" as const,
          suggestions: result.found ? result.value : [],
        };
      }
      if (request.kind === "session-pending-input-history") {
        const { readPendingInputHistoryInWorker } =
          await import("./session-pending-input-history-read.worker.js");
        return {
          kind: "session-pending-input-history",
          snapshot: readPendingInputHistoryInWorker(request),
        };
      }
      if (request.kind === "conversation-rows") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { selectConversationRowsFromDatabase } =
          await import("./session-accessor.sqlite-conversation-read.js");
        const read = withOpenClawAgentDatabaseReadOnly(
          (database) => selectConversationRowsFromDatabase(database, request.query),
          { ...request.database, env: cloneEnvWithPlatformSemantics(request.env) },
        );
        return { kind: "conversation-rows", rows: read.found ? read.value : [] };
      }
      if (request.kind === "conversation-delivery") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { readConversationDeliveryInDatabase } =
          await import("./conversation-delivery-store.kernel.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) => readConversationDeliveryInDatabase(database, request.lookup),
          { ...request.database, env: cloneEnvWithPlatformSemantics(request.env) },
        );
        return { kind: "conversation-delivery", record: result.found ? result.value : undefined };
      }
      if (request.kind === "goal-operation-receipt") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const {
          assertSessionGoalOperationTime,
          readSessionGoalOperationInDatabase,
          SessionGoalOperationError,
        } = await import("./goals-operations.js");
        try {
          assertSessionGoalOperationTime(request.operation, Date.now());
          const result = withOpenClawAgentDatabaseReadOnly(
            (database) => readSessionGoalOperationInDatabase(database, request),
            { ...request.database, env: cloneEnvWithPlatformSemantics(request.env) },
          );
          return {
            kind: "goal-operation-receipt",
            result: { receipt: result.found ? result.value : undefined },
          };
        } catch (error) {
          if (!(error instanceof SessionGoalOperationError)) {
            throw error;
          }
          return {
            kind: "goal-operation-receipt",
            result: { error: { code: error.code, message: error.message } },
          };
        }
      }
      if (request.kind === "session-progress-card") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { readSessionProgressCard } =
          await import("../../session-cards/progress-card-store.js");
        const result = withOpenClawAgentDatabaseReadOnly(
          (database) => readSessionProgressCard(database.db, request.sessionKey),
          { ...request.database, env: request.env },
        );
        return {
          kind: "session-progress-card" as const,
          card: result.found ? result.value : null,
        };
      }
      if (request.kind === "session-row-presence") {
        const { loadSessionEntryReadOnlyInScope } =
          await import("./session-accessor.sqlite-exact-read.js");
        return (
          loadSessionEntryReadOnlyInScope({ ...request.scope, projection: "list" }) !== undefined
        );
      }
      return await runWithSessionTranscriptReadFence(
        request.admission,
        async (): Promise<SessionTranscriptWorkerValues[keyof SessionTranscriptWorkerValues]> => {
          if (request.kind === "session-activity-summary-source") {
            const { readActivitySummaryBatch } =
              await import("../../gateway/session-activity-summary-source.js");
            return {
              kind: "session-activity-summary-source" as const,
              source: readActivitySummaryBatch(request),
            };
          }
          if (
            request.kind === "transcript-hydration" ||
            request.kind === "transcript-maintenance" ||
            request.kind === "current-turn-entry" ||
            request.kind === "recent-active-events" ||
            request.kind === "latest-active-message"
          ) {
            const { readSessionTranscriptHydrationRequest } =
              await import("./session-transcript-hydration-read.worker.js");
            return readSessionTranscriptHydrationRequest(request, channel, control);
          }
          if (request.kind === "history-page") {
            const { readSessionHistoryRequest } =
              await import("../../gateway/session-history-worker-reader.js");
            return readSessionHistoryRequest(request.request, {
              ...request.target,
              database: request.database,
            });
          }
          if (request.kind === "session-reset-recall") {
            const { readSessionResetRecallCutoffInProcess } =
              await import("../../../packages/memory-host-sdk/src/host/session-reset-recall-read.js");
            return { cutoff: readSessionResetRecallCutoffInProcess(request.scope) };
          }
          const { buildSessionEntryInProcess, readSessionEntryResetRecallCutoff } =
            await import("../../../packages/memory-host-sdk/src/host/session-files.js");
          const { createSensitiveTextRedactor } = await import("../../logging/redact.js");
          const entry = await buildSessionEntryInProcess(
            request.absPath,
            request.options,
            createSensitiveTextRedactor(request.redaction),
          );
          return {
            entry,
            resetRecallCutoff: entry
              ? readSessionEntryResetRecallCutoff(entry)
              : { state: "absent" },
          };
        },
      );
    };
    try {
      // Database-addressed reads share one custody and reply boundary; discovery and exports
      // retain their existing owners. The scope opens no connection until a reader asks for it.
      return "database" in request
        ? await withHistoryDatabase(
            request.database,
            request.kind === "history-page"
              ? request.request.kind === "summary"
                ? `history.${request.request.params.query.kind}`
                : `history.${request.request.kind}`
              : request.kind,
            readRequest,
          )
        : { ok: true, value: await readRequest() };
    } catch (error) {
      const encoded = encodeSessionTranscriptRequestError(error, request);
      if (encoded) {
        return { ok: false, error: encoded };
      }
      throw error;
    }
  },
  {
    transferList(reply) {
      if (!reply.ok) {
        return [];
      }
      const value = reply.value;
      if (typeof value !== "object" || value === null || !("kind" in value)) {
        return [];
      }
      const body =
        value.kind === "rpc"
          ? value.page.encodedResponse?.messages
          : value.kind === "artifacts" && value.result.kind === "download-response"
            ? value.result.response?.body
            : undefined;
      return body ? [body.buffer] : [];
    },
    closeResource: (key) => {
      const request = decodeAgentDatabaseReaderRequest(key);
      if (request?.kind !== "close") {
        throw new Error("Session reader cleanup requires captured physical paths");
      }
      releaseReadValidation?.(request.candidates);
      pruneClosedHistoryDatabaseScopes();
    },
  },
);
