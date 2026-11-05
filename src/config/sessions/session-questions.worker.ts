import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type { SessionEntryPatchReceipt } from "./session-entry-patch.types.js";
import {
  bindSessionWorkerBackend,
  type SessionWorkerDatabaseBinding,
  transferSessionEntryWorkerCandidate,
} from "./session-entry-patch.worker.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import { operateSessionQuestion } from "./session-questions.kernel.worker.js";
import type { SessionQuestionOperation, SessionQuestionResult } from "./session-questions.types.js";

export type SessionQuestionCandidate = {
  kind: "session-question";
  result: SessionQuestionResult;
  publication?: SessionEntryReplacementPublication;
};
export type SessionQuestionOperations = {
  "session.question.operate": {
    input: SessionQuestionOperation;
    output: SessionEntryPatchReceipt;
  };
};

/** Private commands use the canonical executor connection, never a second state writer. */
export function bindSqliteWorkerBackend(
  input: { agentId: string },
  bound: SessionWorkerDatabaseBinding,
): SqliteWorkerBackend<SessionQuestionOperations> {
  return bindSessionWorkerBackend<SessionQuestionOperations>(
    input,
    bound,
    "Question",
    ({ admit, writeTransaction }) =>
      ({ input: request }) =>
        writeTransaction("session.question.operate", "Question transaction", (current) => {
          const postimages: SessionEntryWritePostimages = new Map();
          const owner =
            request.kind === "register"
              ? request.question
              : request.kind === "claim"
                ? operateSessionQuestion(current, { kind: "get", id: request.id }, postimages)
                : undefined;
          const question = owner && !Array.isArray(owner) ? owner : undefined;
          const previous = question
            ? readExactSessionEntryRow(current, question.sessionKey)?.entry
            : undefined;
          const result = operateSessionQuestion(current, request, postimages);
          const entry = question ? postimages.get(question.sessionKey)?.entry : undefined;
          const candidate: SessionQuestionCandidate = {
            kind: "session-question",
            result,
            publication:
              previous && entry && question
                ? prepareSessionEntryReplacementPublication(
                    {
                      previous: new Map([[question.sessionKey, previous]]),
                      current: new Map([[question.sessionKey, entry]]),
                      pendingArchiveRecovery: false,
                      membershipInvalidatedKeys: [],
                      maintenancePlans: [],
                    },
                    current,
                    { captureFullFacts: true, postimages },
                  )
                : undefined,
          };
          return transferSessionEntryWorkerCandidate(current, admit, candidate);
        }),
  );
}
