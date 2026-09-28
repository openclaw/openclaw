import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { parseSessionPendingInputMessage } from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

export type SessionPendingInputWithdrawal = {
  sessionKey: string;
  sessionId: string;
  runId: string;
};

type SessionPendingInputWithdrawalReceipt = SessionPendingInputWithdrawal & {
  kind: "session-pending-input-withdrawal";
  withdrawn: boolean;
};

/** Retain the accepted receipt while withdrawing only an input the agent has not consumed. */
export function discardSessionPendingInputInWorker(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: SessionPendingInputWithdrawal,
  admit: (stage: "transaction" | "commit", publication?: unknown) => void,
): boolean {
  return runOpenClawAgentWriteTransaction(
    (current) => {
      if (current.db !== database.db) {
        throw new Error("Pending input withdrawal lost its canonical database owner");
      }
      admit("transaction");
      const commitResult = (withdrawn: boolean) => {
        const receipt: SessionPendingInputWithdrawalReceipt = {
          kind: "session-pending-input-withdrawal",
          ...input,
          withdrawn,
        };
        deferSqliteWorkerCommitReceipt(current.db, receipt);
        admit("commit", receipt);
        return withdrawn;
      };
      const schema = getAdmittedSqliteSchemaFacts(current.db);
      if (!schema) {
        throw new Error("Pending input withdrawal requires admitted schema facts");
      }
      if (!schema.tables.has("session_pending_inputs")) {
        return commitResult(false);
      }
      const db = getSessionKysely(current.db);
      const session = executeSqliteQueryTakeFirstSync(
        current.db,
        db
          .selectFrom("session_nodes")
          .select("current_session_id")
          .where("session_key", "=", input.sessionKey),
      );
      if (session?.current_session_id !== input.sessionId) {
        return commitResult(false);
      }
      const rows = executeSqliteQuerySync(
        current.db,
        db
          .selectFrom("session_pending_inputs")
          .select(["input_id", "message_json"])
          .where("session_key", "=", input.sessionKey)
          .where("session_id", "=", input.sessionId)
          .where("run_id", "=", input.runId)
          .where("consumed_event_id", "is", null)
          .limit(2),
      ).rows;
      const row = rows.length === 1 ? rows[0] : undefined;
      if (!row) {
        return commitResult(false);
      }
      const message = parseSessionPendingInputMessage(row.message_json);
      const result = executeSqliteQuerySync(
        current.db,
        db
          .updateTable("session_pending_inputs")
          .set({ state: "cancelled", message_json: JSON.stringify({ ...message, display: false }) })
          .where("input_id", "=", row.input_id)
          .where("session_key", "=", input.sessionKey)
          .where("session_id", "=", input.sessionId)
          .where("run_id", "=", input.runId)
          .where("consumed_event_id", "is", null),
      );
      return commitResult(result.numAffectedRows === 1n);
    },
    options,
    { operationLabel: "session.pending-input.withdraw" },
  );
}
