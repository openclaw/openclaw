import type {
  UsageCostWorkerInput,
  UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import type { SessionIdentityEvidenceResult } from "./session-accessor.sqlite-entry-availability.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { SessionHistoryWorkerResult } from "./session-history-types.js";
import { sessionHistoryCleanupError } from "./session-history-worker-errors.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type {
  SessionBranchSummaryWorkerInput,
  SessionEntryWorkerInput,
  SessionEntryListWorkerInput,
  SessionTargetInventoryWorkerInput,
  SessionIdentityEvidenceWorkerInput,
  SessionMembersWorkerInput,
  SessionModelContextWorkerInput,
  SessionRowPresenceWorkerInput,
  SessionTranscriptHistoryWorkerInput,
  SessionTranscriptWorkerReply,
  SessionTranscriptWorkerValues,
  SessionUsageCacheWorkerInput,
  SessionTranscriptSearchWorkerInput,
} from "./session-transcript-worker.types.js";

// Keep target switching within the existing serialized worker; no read snapshot survives a task.
const MAX_RETAINED_HISTORY_DATABASES = 64;
const historyDatabaseScopes = new Map<
  string,
  {
    database: SessionTranscriptHistoryWorkerInput["database"];
    scope: import("../../state/openclaw-agent-db-readonly-scope.js").OpenClawAgentDatabaseReadOnlyScope;
  }
>();

async function withHistoryDatabase<T>(
  database: SessionTranscriptHistoryWorkerInput["database"],
  operation: () => T | Promise<T>,
): Promise<{ value: T; closedHistoryDatabase?: SessionTranscriptHistoryWorkerInput["database"] }> {
  const key = JSON.stringify(database);
  let retained = historyDatabaseScopes.get(key);
  if (!retained) {
    const { OpenClawAgentDatabaseReadOnlyScope } =
      await import("../../state/openclaw-agent-db-readonly-scope.js");
    retained = { database, scope: new OpenClawAgentDatabaseReadOnlyScope() };
  }
  const { scope } = retained;
  try {
    const value = await scope.run(database, operation);
    historyDatabaseScopes.delete(key);
    // Missing stores must not evict useful connections or retain empty scopes.
    if (!scope.hasRetainedConnection) {
      return { value, closedHistoryDatabase: database };
    }
    historyDatabaseScopes.set(key, retained);
    if (historyDatabaseScopes.size > MAX_RETAINED_HISTORY_DATABASES) {
      const oldest = historyDatabaseScopes.entries().next().value!;
      oldest[1].scope.close();
      historyDatabaseScopes.delete(oldest[0]);
      return { value, closedHistoryDatabase: oldest[1].database };
    }
    return { value };
  } catch (error) {
    // The parent joins worker retirement on failure, including a failed native close.
    try {
      scope.close();
    } catch (cleanupError) {
      throw sessionHistoryCleanupError(error, cleanupError, "database close");
    }
    throw error;
  }
}

serveWorkerTasks(
  async (
    input,
    channel,
    control,
  ): Promise<
    SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues> | UsageCostWorkerReply
  > => {
    // SAFETY: The paired runtime constructs this request; the SQLite snapshot validates admission.
    const request = input as
      | SessionModelContextWorkerInput
      | SessionEntryWorkerInput
      | SessionEntryListWorkerInput
      | SessionTargetInventoryWorkerInput
      | SessionIdentityEvidenceWorkerInput
      | SessionTranscriptHistoryWorkerInput
      | SessionRowPresenceWorkerInput
      | SessionMembersWorkerInput
      | SessionUsageCacheWorkerInput
      | SessionTranscriptSearchWorkerInput
      | SessionBranchSummaryWorkerInput
      | UsageCostWorkerInput;
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
            const result = await withHistoryDatabase(database, read);
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
    try {
      if (request.kind === "transcript-search") {
        const { searchSessionTranscriptsReadOnlySync } =
          await import("./session-transcript-search.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(request.database, () => ({
            kind: "transcript-search" as const,
            result: searchSessionTranscriptsReadOnlySync(request.params, {
              ...request.database,
              env: cloneEnvWithPlatformSemantics(request.params.env ?? process.env),
            }),
          }))),
        };
      }
      if (request.kind === "session-target-inventory") {
        const { readSessionStoreTargetInventory } =
          await import("./session-store-target-inventory.js");
        return { ok: true, value: readSessionStoreTargetInventory(request.request) };
      }
      if (request.kind === "session-identity-evidence") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { readSessionIdentityEvidenceInDatabase } =
          await import("./session-accessor.sqlite-entry-availability.js");
        const { readWithCanonicalSessionReaderContinuation } =
          await import("./session-canonical-key.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(request.database, () => {
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
          })),
        };
      }
      if (request.kind === "session-entry-list") {
        const { listSessionEntriesReadOnly } = await import("./session-accessor.sqlite-entry.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(request.database, () => ({
            kind: "session-entry-list" as const,
            entries: listSessionEntriesReadOnly({
              ...request.scope,
              env: cloneEnvWithPlatformSemantics(request.scope.env ?? process.env),
            }),
          }))),
        };
      }
      if (request.kind === "usage-cache") {
        const { readSessionCostUsageCache } =
          await import("../../infra/session-cost-usage-cache-read.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(request.database, () =>
            readSessionCostUsageCache({ ...request.database, env: request.env }, request.request),
          )),
        };
      }
      if (request.kind === "branch-summaries") {
        const { readSessionBranchSummariesInWorker } =
          await import("./session-accessor.sqlite-branches.js");
        return { ok: true, value: readSessionBranchSummariesInWorker(request.request) };
      }
      if (request.kind === "session-members") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { listSessionMembersInDatabase } = await import("./session-sharing-store.kernel.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(request.database, () => {
            const result = withOpenClawAgentDatabaseReadOnly(
              (database) => listSessionMembersInDatabase(database, request.sessionKey),
              { ...request.database, env: request.env },
            );
            return result.found ? result.value : [];
          })),
        };
      }
      if (request.kind === "session-row-presence") {
        const { loadSessionEntryReadOnlyInScope } =
          await import("./session-accessor.sqlite-entry.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(
            request.database,
            () =>
              loadSessionEntryReadOnlyInScope({ ...request.scope, projection: "list" }) !==
              undefined,
          )),
        };
      }
      return await runWithSessionTranscriptReadFence(
        request.admission,
        async (): Promise<SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues>> => {
          if (request.kind === "model-context") {
            const { readSessionTranscriptModelContext } =
              await import("./session-accessor.sqlite-model-context.js");
            return {
              ok: true,
              value: readSessionTranscriptModelContext(
                request.target,
                request.through,
                request.limits,
              ),
            };
          }
          if (request.kind === "history-page") {
            return {
              ok: true,
              ...(await withHistoryDatabase<SessionHistoryWorkerResult>(
                request.database,
                async () => {
                  const { createReadonlySessionHistoryReader } =
                    await import("../../gateway/session-history-readonly-reader.js");
                  const options = {
                    readers: createReadonlySessionHistoryReader({
                      ...request.target,
                      database: request.database,
                    }),
                    readOnly: true,
                    deferProfileDisplay: true,
                    resolveCronJobName: () => undefined,
                  };
                  if (request.request.kind === "delta") {
                    return {
                      kind: "delta",
                      delta: options.readers.readTranscriptDisplayDelta(
                        request.request.params.limits,
                      ),
                    };
                  }
                  if (request.request.kind === "rpc") {
                    const { readChatHistoryPageKernel } =
                      await import("../../gateway/server-methods/chat-history-page-kernel.js");
                    return {
                      kind: "rpc",
                      page: await readChatHistoryPageKernel(request.request.params, options),
                    };
                  }
                  const { readSessionHistorySnapshotKernel } =
                    await import("../../gateway/session-history-snapshot.js");
                  return {
                    kind: "http",
                    snapshot: await readSessionHistorySnapshotKernel(
                      request.request.params,
                      options,
                    ),
                  };
                },
              )),
            };
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
            ok: true,
            value: {
              entry,
              resetRecallCutoff: entry
                ? readSessionEntryResetRecallCutoff(entry)
                : { state: "absent" },
            },
          };
        },
      );
    } catch (error) {
      if (error instanceof SessionTranscriptColdError) {
        return { ok: false, error: { kind: "cold", sessionId: error.sessionId } };
      }
      if (error instanceof SessionTranscriptProjectionUnavailableError) {
        return { ok: false, error: { kind: "projection", sessionId: error.sessionId } };
      }
      if (error instanceof SessionTranscriptReadFenceError) {
        return { ok: false, error: { kind: "fence", message: error.message } };
      }
      throw error;
    }
  },
);
