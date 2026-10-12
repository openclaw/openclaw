import type { DatabaseSync } from "node:sqlite";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import type { SessionTranscriptStats } from "./session-accessor.sqlite-contract.js";
import { readTranscriptStatsFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";

export type SessionTranscriptStatsOperations = {
  read: { input: { sessionId: string }; output: SessionTranscriptStats };
};

/** Borrow the canonical executor without expanding the released history-reader contract. */
export function bindSqliteWorkerBackend(
  _input: unknown,
  bound: { database: DatabaseSync },
): SqliteWorkerBackend<SessionTranscriptStatsOperations> {
  return {
    execute(command) {
      return readTranscriptStatsFromDatabase({ db: bound.database }, command.input.sessionId);
    },
    assertSettled() {
      assertTransactionUsable(bound.database);
      if (bound.database.isTransaction) {
        throw new Error("Transcript statistics transaction did not settle");
      }
    },
    close() {},
  };
}
