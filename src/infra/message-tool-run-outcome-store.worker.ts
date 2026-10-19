import type { Result } from "@openclaw/normalization-core/result";
import { ensureMessageToolRunOutcomeSchema } from "../state/openclaw-agent-message-tool-outcome-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import {
  recordMessageToolRunOutcomeInDatabase,
  type MessageToolRunOutcomeInsert,
} from "./message-tool-run-outcome-store.kernel.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { bindSqliteWorkerDatabase } from "./sqlite-worker-binding.js";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "./sqlite-worker-database-context.js";
import { encodeSqliteWorkerDomainError } from "./sqlite-worker-domain-error.js";

export type MessageToolRunOutcomeWorkerOperations = {
  record: {
    input: MessageToolRunOutcomeInsert;
    output: Result<void, OpenClawStateWorkerErrorPayload>;
  };
};

export function bindSqliteWorkerBackend(
  _input: undefined,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<MessageToolRunOutcomeWorkerOperations> {
  const db = context.database;
  return bindSqliteWorkerDatabase<MessageToolRunOutcomeWorkerOperations>(db, {
    execute(command) {
      try {
        runSqliteImmediateTransactionSync(
          db,
          () => {
            context.admit("transaction");
            ensureMessageToolRunOutcomeSchema(db);
            recordMessageToolRunOutcomeInDatabase(db, command.input);
          },
          {
            operationLabel: "message-tool.run-outcome.record",
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: context.databasePath,
            withCommit(commit) {
              context.admit("commit");
              commit();
            },
          },
        );
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: encodeSqliteWorkerDomainError(db, error) };
      }
    },
  });
}
