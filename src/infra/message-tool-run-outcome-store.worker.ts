import type { DatabaseSync } from "node:sqlite";
import type { Result } from "@openclaw/normalization-core/result";
import { ensureMessageToolRunOutcomeSchema } from "../state/openclaw-agent-message-tool-outcome-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import {
  encodeOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import {
  recordMessageToolRunOutcomeInDatabase,
  type MessageToolRunOutcomeInsert,
} from "./message-tool-run-outcome-store.kernel.js";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";

export type MessageToolRunOutcomeWorkerOperations = {
  record: {
    input: MessageToolRunOutcomeInsert;
    output: Result<void, OpenClawStateWorkerErrorPayload>;
  };
};

export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<MessageToolRunOutcomeWorkerOperations> {
  const db = context.database;
  return {
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
        // Only a settled rollback is a domain failure; uncertain native work stays with the broker.
        assertTransactionUsable(db);
        if (!db.isOpen || db.isTransaction) {
          throw error;
        }
        const failure = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
        if (!failure) {
          throw error;
        }
        return { ok: false, error: failure };
      }
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Message-tool outcome transaction did not settle");
      }
    },
    close() {},
  };
}
