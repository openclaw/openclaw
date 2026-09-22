import type {
  BuildSessionEntryOptions,
  SessionFileEntry,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import { serveWorkerTasks } from "../../infra/worker-task-pool.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionBranchSummaryReadRequest,
  SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import type {
  readSessionTranscriptModelContext,
  SessionModelContextLimits,
} from "./session-accessor.sqlite-model-context.js";
import type {
  SessionAccessScope,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type {
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "./session-history-types.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type SessionModelContextWorkerInput = {
  kind: "model-context";
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  through?: TranscriptEntryAnchor;
  limits?: SessionModelContextLimits;
};

export type SessionEntryWorkerInput = {
  kind: "session-entry";
  absPath: string;
  options: Omit<BuildSessionEntryOptions, "onTranscriptMessage" | "parseYieldEveryLines"> & {
    agentId: string;
    sessionId: string;
    storePath: string;
  };
  admission?: UserTurnTranscriptAdmissionReceipt;
  redaction: SensitiveTextRedactionSnapshot;
};

export type SessionTranscriptHistoryWorkerInput = {
  kind: "history-page";
  database: { agentId: string; path: string };
  request: SessionHistoryWorkerRequest;
  target: Omit<PreparedSessionHistoryReadTarget, "database">;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionRowPresenceWorkerInput = {
  kind: "session-row-presence";
  database: { agentId: string; path: string };
  scope: SessionAccessScope & { databaseAgentId: string };
};

export type SessionBranchSummaryWorkerInput = {
  kind: "branch-summaries";
  request: SessionBranchSummaryReadRequest;
};

type SessionTranscriptWorkerValues = {
  "branch-summaries": SessionBranchSummaryReadResult;
  "history-page": SessionHistoryWorkerResult;
  "session-row-presence": boolean;
  "model-context": ReturnType<typeof readSessionTranscriptModelContext>;
  "session-entry": {
    entry: SessionFileEntry | null;
    resetRecallCutoff: ReturnType<typeof readSessionEntryResetRecallCutoff>;
  };
};

export type SessionTranscriptWorkerReply<Kind extends keyof SessionTranscriptWorkerValues> =
  | {
      ok: true;
      value: SessionTranscriptWorkerValues[Kind];
      closedHistoryDatabase?: SessionTranscriptHistoryWorkerInput["database"];
    }
  | {
      ok: false;
      error:
        | { kind: "cold"; sessionId: string }
        | { kind: "projection"; sessionId: string }
        | { kind: "fence"; message: string };
    };

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
    scope.close();
    throw error;
  }
}

serveWorkerTasks(
  async (input): Promise<SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues>> => {
    // SAFETY: The paired runtime constructs this request; the SQLite snapshot validates admission.
    const request = input as
      | SessionModelContextWorkerInput
      | SessionEntryWorkerInput
      | SessionTranscriptHistoryWorkerInput
      | SessionRowPresenceWorkerInput
      | SessionBranchSummaryWorkerInput;
    try {
      if (request.kind === "branch-summaries") {
        const { readSessionBranchSummariesInWorker } =
          await import("./session-accessor.sqlite-branches.js");
        return { ok: true, value: readSessionBranchSummariesInWorker(request.request) };
      }
      if (request.kind === "session-row-presence") {
        const { loadSessionEntryReadOnlyInScope } =
          await import("./session-accessor.sqlite-entry.js");
        return {
          ok: true,
          ...(await withHistoryDatabase(
            request.database,
            () => loadSessionEntryReadOnlyInScope(request.scope) !== undefined,
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
