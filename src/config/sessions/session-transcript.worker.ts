import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  UsageCostWorkerInput,
  UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import { serveOwnedWorkerTasks } from "../../infra/worker-task-server.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import type { SessionIdentityEvidenceResult } from "./session-accessor.sqlite-entry-availability.js";
import type { SessionHistoryWorkerResult } from "./session-history-types.js";
import {
  encodeSessionTranscriptWorkerError,
  SessionHistoryDeltaPreparationError,
  sessionHistoryCleanupError,
} from "./session-history-worker-errors.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionTranscriptHistoryWorkerInput,
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerReply,
  SessionTranscriptWorkerValues,
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
    // Tasks without retained connections must not evict useful connections or retain empty scopes.
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

let closeReadOnlyCandidates:
  | typeof import("../../state/openclaw-agent-db-readonly-scope.js").closeOpenClawAgentDatabaseReadOnlyCandidates
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
    closeReadOnlyCandidates ??= (await import("../../state/openclaw-agent-db-readonly-scope.js"))
      .closeOpenClawAgentDatabaseReadOnlyCandidates;
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
      if (request.kind === "session-store-target") {
        const { readSessionStoreTarget } = await import("./session-store-target-inventory.js");
        return { ok: true, value: readSessionStoreTarget(request.request) };
      }
      if (request.kind === "session-exact-entries") {
        const { readExactSessionEntriesWithLifecycle } =
          await import("./session-entry-read.worker.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(request.database, () =>
            readExactSessionEntriesWithLifecycle(request),
          )),
        };
      }
      if (request.kind === "session-row-facts") {
        const { readSessionRowDatabaseFacts } = await import("./session-entry-read.worker.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(request.database, () =>
            readSessionRowDatabaseFacts(request),
          )),
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
        const { listSessionEntriesReadOnly } =
          await import("./session-accessor.sqlite-entry-list.read.js");
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
      if (request.kind === "session-membership-facts") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { readSessionMembershipFactsInDatabase } =
          await import("./session-membership-facts.js");
        const { readWithCanonicalSessionReaderContinuation } =
          await import("./session-canonical-key.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(request.database, () => {
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
          })),
        };
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
      if (request.kind === "session-progress-card") {
        const { withOpenClawAgentDatabaseReadOnly } =
          await import("../../state/openclaw-agent-db-readonly.js");
        const { readSessionProgressCard } =
          await import("../../session-cards/progress-card-store.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(request.database, () => {
            const result = withOpenClawAgentDatabaseReadOnly(
              (database) => readSessionProgressCard(database.db, request.sessionKey),
              { ...request.database, env: request.env },
            );
            return {
              kind: "session-progress-card" as const,
              card: result.found ? result.value : null,
            };
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
          if (request.kind === "session-title-fields") {
            const { readSessionTitleFieldsFromTranscript } =
              await import("../../gateway/session-transcript-title-reader.js");
            return {
              ok: true,
              ...(await withHistoryDatabase(request.database, () => ({
                kind: "session-title-fields" as const,
                fields: readSessionTitleFieldsFromTranscript(request.scope, {
                  includeInterSession: request.includeInterSession,
                  readOnly: true,
                }),
              }))),
            };
          }
          if (request.kind === "session-preview") {
            const { readSessionPreviewItemsReadOnly } =
              await import("../../gateway/session-transcript-preview-reader.js");
            return {
              ok: true,
              ...(await withHistoryDatabase(request.database, () => ({
                kind: "session-preview" as const,
                items: readSessionPreviewItemsReadOnly(request),
              }))),
            };
          }
          if (request.kind === "transcript-hydration" || request.kind === "current-turn-entry") {
            const { readOpenClawDatabaseQuarantineFailure } =
              await import("../../state/openclaw-quarantine-store.js");
            const quarantine = readOpenClawDatabaseQuarantineFailure(
              "agent",
              request.database.path,
              {
                env: request.target.env,
              },
            );
            if (quarantine) {
              throw quarantine;
            }
            if (request.kind === "current-turn-entry") {
              const { readSessionTranscriptCurrentTurnEntry } =
                await import("./session-accessor.sqlite-current-turn.js");
              return {
                ok: true,
                ...(await withHistoryDatabase(request.database, () =>
                  readSessionTranscriptCurrentTurnEntry(request.target, {
                    entryId: request.entryId,
                    version: request.version,
                    includeEntry: request.includeEntry,
                    readOnly: true,
                    resolvedScope: request.resolvedScope,
                  }),
                )),
              };
            }
            const { readSessionTranscriptBoundedActiveContextCore } =
              await import("./session-accessor.sqlite-active-context.js");
            const { streamSessionTranscriptHydration } =
              await import("./session-transcript-hydration.worker.js");
            return {
              ok: true,
              ...(await withHistoryDatabase<SessionTranscriptWorkerValues["transcript-hydration"]>(
                request.database,
                () => {
                  if (request.limits) {
                    return {
                      kind: "bounded" as const,
                      snapshot: readSessionTranscriptBoundedActiveContextCore(request.target, {
                        ...request.limits,
                        readOnly: true,
                        resolvedScope: request.resolvedScope,
                      }),
                    };
                  }
                  if (!channel) {
                    throw new Error("Full transcript hydration requires its host channel");
                  }
                  return streamSessionTranscriptHydration(request, channel, control);
                },
              )),
            };
          }
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
                  if (request.request.kind === "message-lookup") {
                    return {
                      kind: "message-lookup",
                      messages: await options.readers.readSessionMessagesMatchingIdAsync(
                        request.request.params.target,
                        request.request.params.messageId,
                      ),
                    };
                  }
                  if (request.request.kind === "delta") {
                    const { prepareSessionHistoryDelta } =
                      await import("../../gateway/session-history-delta-visibility.js");
                    return {
                      kind: "delta",
                      ...prepareSessionHistoryDelta(
                        options.readers.readTranscriptDisplayDelta(request.request.params.limits),
                        options.readers.subagentCoordination,
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
      if (
        error instanceof SessionHistoryDeltaPreparationError &&
        request.kind === "history-page" &&
        request.request.kind === "delta"
      ) {
        // Keep the failed-reply path: auxiliary readers may also need retirement.
        // The host joins worker exit before consuming any partial visibility facts.
        return {
          ok: false,
          error: { kind: "delta-visibility", partial: error.partial },
        };
      }
      if (
        error instanceof SyntaxError &&
        request.kind === "history-page" &&
        request.request.kind === "message-lookup"
      ) {
        return { ok: false, error: { kind: "syntax", message: error.message } };
      }
      const encoded = encodeSessionTranscriptWorkerError(error);
      if (encoded) {
        return { ok: false, error: encoded };
      }
      throw error;
    }
  },
  {
    closeResource: (key) => {
      const parsed: unknown = key === undefined ? undefined : JSON.parse(key);
      if (
        !Array.isArray(parsed) ||
        !parsed.every(
          (candidate) =>
            isRecord(candidate) &&
            typeof candidate.path === "string" &&
            (candidate.scope === undefined || candidate.scope === "sibling-family"),
        )
      ) {
        throw new Error("Session reader cleanup requires captured physical paths");
      }
      const candidates = parsed.map((candidate: { path: string; scope?: "sibling-family" }) =>
        candidate.scope
          ? { path: candidate.path, scope: candidate.scope }
          : { path: candidate.path },
      );
      closeReadOnlyCandidates?.(candidates);
      for (const [identity, retained] of historyDatabaseScopes) {
        if (!retained.scope.hasRetainedConnection) {
          historyDatabaseScopes.delete(identity);
        }
      }
    },
  },
);
