import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { PendingInputHistoryReceipt } from "./session-pending-input-history.types.js";

/** The physical writer FIFO keeps the host's live-owner plan ordered with publication. */
export function interruptPendingInputHistoryInDatabase(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: { sessionKey: string; sessionId: string; ids: string[] },
  admit: (stage: "commit", publication: PendingInputHistoryReceipt) => void,
  publish: (receipt: PendingInputHistoryReceipt) => void,
): PendingInputHistoryReceipt {
  if (input.ids.length > 20) {
    throw new Error("Pending input reconciliation exceeds its page bound");
  }
  return runOpenClawAgentWriteTransaction(
    (current) => {
      if (current.db !== database.db) {
        throw new Error("Pending input history lost its database owner");
      }
      const db = getSessionKysely(current.db);
      const interrupted = executeSqliteQuerySync(
        current.db,
        db
          .updateTable("session_pending_inputs")
          .set({ state: "interrupted" })
          .where("session_key", "=", input.sessionKey)
          .where("session_id", "=", input.sessionId)
          .where("input_id", "in", input.ids)
          .where("state", "=", "queued")
          .where("consumed_event_id", "is", null)
          .returning("input_id"),
      ).rows;
      const receipt: PendingInputHistoryReceipt = {
        kind: "pending-input-history-interrupted",
        ids: interrupted.map((row) => row.input_id),
      };
      publish(receipt);
      admit("commit", receipt);
      return receipt;
    },
    options,
    { operationLabel: "session.pending-input.interrupt-stale" },
  );
}
