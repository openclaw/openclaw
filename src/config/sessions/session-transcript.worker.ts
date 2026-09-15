import type {
  BuildSessionEntryOptions,
  SessionFileEntry,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { serveWorkerTasks } from "../../infra/worker-task-pool.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionBranchSummaryReadRequest,
  SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import type { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
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
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionBranchSummaryWorkerInput = {
  kind: "branch-summaries";
  request: SessionBranchSummaryReadRequest;
};

type SessionTranscriptWorkerValues = {
  "branch-summaries": SessionBranchSummaryReadResult;
  "history-page": SessionHistoryWorkerResult;
  "model-context": ReturnType<typeof readSessionTranscriptModelContext>;
  "session-entry": {
    entry: SessionFileEntry | null;
    resetRecallCutoff: ReturnType<typeof readSessionEntryResetRecallCutoff>;
    readError?: string;
  };
};

export type SessionTranscriptWorkerReply<Kind extends keyof SessionTranscriptWorkerValues> =
  | { ok: true; value: SessionTranscriptWorkerValues[Kind] }
  | {
      ok: false;
      error:
        | { kind: "cold"; sessionId: string }
        | { kind: "projection"; sessionId: string }
        | { kind: "fence"; message: string };
    };

let historyDatabaseScope:
  | import("../../state/openclaw-agent-db-readonly.js").OpenClawAgentDatabaseReadOnlyScope
  | undefined;

serveWorkerTasks(
  async (input): Promise<SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues>> => {
    // SAFETY: The paired runtime constructs this request; the SQLite snapshot validates admission.
    const request = input as
      | SessionModelContextWorkerInput
      | SessionEntryWorkerInput
      | SessionTranscriptHistoryWorkerInput
      | SessionBranchSummaryWorkerInput;
    try {
      if (request.kind === "branch-summaries") {
        const { readSessionBranchSummariesInWorker } =
          await import("./session-accessor.sqlite-branches.js");
        return { ok: true, value: readSessionBranchSummariesInWorker(request.request) };
      }
      return await runWithSessionTranscriptReadFence(
        request.admission,
        async (): Promise<SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues>> => {
          if (request.kind === "model-context") {
            const { readSessionTranscriptModelContext } =
              await import("./session-accessor.sqlite-model-context.js");
            return {
              ok: true,
              value: readSessionTranscriptModelContext(request.target, request.through),
            };
          }
          if (request.kind === "history-page") {
            if (!historyDatabaseScope) {
              const { OpenClawAgentDatabaseReadOnlyScope } =
                await import("../../state/openclaw-agent-db-readonly.js");
              historyDatabaseScope = new OpenClawAgentDatabaseReadOnlyScope();
            }
            return historyDatabaseScope.run(request.database, async () => {
              const options = { readOnly: true, deferProfileDisplay: true };
              if (request.request.kind === "rpc") {
                const { readChatHistoryPageLocal } =
                  await import("../../gateway/server-methods/chat-history-pages.js");
                return {
                  ok: true,
                  value: {
                    kind: "rpc",
                    page: await readChatHistoryPageLocal(request.request.params, options),
                  },
                };
              }
              const { readSessionHistorySnapshotLocal } =
                await import("../../gateway/session-history-state.js");
              return {
                ok: true,
                value: {
                  kind: "http",
                  snapshot: await readSessionHistorySnapshotLocal(request.request.params, options),
                },
              };
            });
          }
          const { buildSessionEntryInProcess, readSessionEntryResetRecallCutoff } =
            await import("../../../packages/memory-host-sdk/src/host/session-files.js");
          const { createSensitiveTextRedactor } = await import("../../logging/redact.js");
          let readError: string | undefined;
          const entry = await buildSessionEntryInProcess(
            request.absPath,
            request.options,
            createSensitiveTextRedactor(request.redaction),
            (error) => {
              readError = String(error);
            },
          );
          return {
            ok: true,
            value: {
              entry,
              resetRecallCutoff: entry
                ? readSessionEntryResetRecallCutoff(entry)
                : { state: "absent" },
              ...(readError !== undefined ? { readError } : {}),
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
