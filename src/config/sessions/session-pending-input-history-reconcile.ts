import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type {
  PendingInputHistoryGrant,
  PendingInputHistoryReceipt,
} from "./session-pending-input-history.types.js";

/** Reconciliation shares the canonical writer; no planned ownership survives a host grant. */
export function interruptPendingInputHistoryInDatabase(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: { sessionKey: string; sessionId: string; ids: string[] },
  admit: (stage: "transaction" | "commit", publication: PendingInputHistoryGrant) => void,
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
      const candidates = executeSqliteQuerySync(
        current.db,
        db
          .selectFrom("session_pending_inputs")
          .select([
            "input_id",
            "session_key",
            "session_id",
            "lifecycle_generation",
            db
              .selectFrom("session_nodes")
              .select("current_session_id")
              .where("session_key", "=", input.sessionKey)
              .as("current_session_id"),
          ])
          .where("session_key", "=", input.sessionKey)
          .where("session_id", "=", input.sessionId)
          .where("input_id", "in", input.ids)
          .where("state", "=", "queued")
          .where("consumed_event_id", "is", null),
      ).rows;
      const currentSessionId = candidates[0]?.current_session_id ?? undefined;
      const protectedRows = new Int32Array(
        new SharedArrayBuffer(candidates.length * Int32Array.BYTES_PER_ELEMENT),
      );
      admit("transaction", {
        kind: "pending-input-history-custody",
        candidates,
        currentSessionId,
        protected: protectedRows.buffer,
      });
      const interrupted = candidates.filter((_, index) => Atomics.load(protectedRows, index) === 0);
      const ids = interrupted.map((row) => row.input_id);
      if (ids.length) {
        executeSqliteQuerySync(
          current.db,
          db
            .updateTable("session_pending_inputs")
            .set({ state: "interrupted" })
            .where("input_id", "in", ids)
            .where("state", "=", "queued")
            .where("consumed_event_id", "is", null),
        );
      }
      const receipt: PendingInputHistoryReceipt = {
        kind: "pending-input-history-interrupted",
        ids,
      };
      publish(receipt);
      admit("commit", {
        kind: "pending-input-history-custody",
        candidates: interrupted,
        currentSessionId,
      });
      return receipt;
    },
    options,
    { operationLabel: "session.pending-input.interrupt-stale" },
  );
}
