import type { DatabaseSync } from "node:sqlite";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import {
  createSessionWorkerOperationContext,
  transferSessionEntryWorkerCandidate,
} from "./session-entry-patch.worker.js";
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
    output: ReturnType<typeof transferSessionEntryWorkerCandidate>;
  };
};

/** Private commands use the canonical executor connection, never a second state writer. */
export function bindSqliteWorkerBackend(
  input: { agentId: string },
  bound: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): SqliteWorkerBackend<SessionQuestionOperations> {
  const options = {
    agentId: input.agentId,
    path: bound.databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== bound.database) {
    throw new Error("Question storage lost its canonical database owner.");
  }
  const { admit, writeTransaction } = createSessionWorkerOperationContext(
    database,
    options,
    bound,
    "Question",
  );
  return {
    execute({ input: request }) {
      return writeTransaction("session.question.operate", "Question transaction", (current) => {
        admit("transaction");
        const owner =
          request.kind === "register"
            ? request.question
            : request.kind === "claim"
              ? operateSessionQuestion(current, { kind: "get", id: request.id })
              : undefined;
        const question = owner && !Array.isArray(owner) ? owner : undefined;
        const previous = question
          ? readSessionEntryRow(current, question.sessionKey)?.entry
          : undefined;
        const result = operateSessionQuestion(current, request);
        const entry = question
          ? readSessionEntryRow(current, question.sessionKey)?.entry
          : undefined;
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
                )
              : undefined,
        };
        return transferSessionEntryWorkerCandidate(current, admit, candidate);
      });
    },
    assertSettled() {
      assertTransactionUsable(database.db);
      if (database.db.isTransaction) {
        throw new Error("Question transaction did not settle.");
      }
    },
    close() {},
  };
}
