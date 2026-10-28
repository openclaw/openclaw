import { getPostgresPhysicalFacts } from "../../infra/database-engine/physical-facts.js";
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
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";

export type SessionPendingInputWithdrawal = {
  sessionKey: string;
  sessionId: string;
} & ({ runId: string } | { inputIds: readonly string[] } | { lifecycleGeneration: string });

export type RetiredPendingInputDismissalOutcome =
  | { kind: "dismissed"; inputIds: string[]; runIds: string[]; missingIds: string[] }
  | { kind: "active"; inputIds: string[] }
  | { kind: "stale" };

export type SessionPendingInputWithdrawalResult = boolean | RetiredPendingInputDismissalOutcome;

/** Retain accepted receipts while hiding only inputs the agent has not consumed. */
export function discardSessionPendingInputInWorker(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: SessionPendingInputWithdrawal,
  admit: (stage: "transaction" | "commit", publication?: unknown) => void,
): SessionPendingInputWithdrawalResult {
  return runOpenClawAgentWriteTransaction(
    (current) => {
      if (current.db !== database.db) {
        throw new Error("Pending input withdrawal lost its canonical database owner");
      }
      const commitResult = (outcome: SessionPendingInputWithdrawalResult) => {
        const receipt = { kind: "session-pending-input-withdrawal", ...input, outcome };
        deferSqliteWorkerCommitReceipt(current.db, receipt);
        admit("commit", receipt);
        return outcome;
      };
      const schema =
        getPostgresPhysicalFacts(current.db) ?? getAdmittedSqliteSchemaFacts(current.db);
      if (!schema) {
        throw new Error("Pending input withdrawal requires admitted schema facts");
      }
      if (!hasSessionPendingInputsSchema(current.db)) {
        admit("transaction");
        return commitResult(
          !("inputIds" in input)
            ? false
            : {
                kind: "dismissed",
                inputIds: [],
                runIds: [],
                missingIds: [...input.inputIds],
              },
        );
      }
      const db = getSessionKysely(current.db);
      if ("lifecycleGeneration" in input) {
        const entry = readSessionEntryRow(current, input.sessionKey, "list")?.entry;
        const marked =
          entry?.sessionId === input.sessionId
            ? (entry.resumeAfterRestart?.queuedInputIds ?? [])
            : [];
        admit("transaction");
        // A crash has no restart marker. Retain its text as a resendable failed send;
        // current-lifecycle admissions and explicitly marked graceful input keep custody.
        executeSqliteQuerySync(
          current.db,
          db
            .updateTable("session_pending_inputs")
            .set({ state: "cancelled" })
            .where("session_key", "=", input.sessionKey)
            .where("session_id", "=", input.sessionId)
            .where("state", "=", "queued")
            .where("consumed_event_id", "is", null)
            .where("lifecycle_generation", "!=", input.lifecycleGeneration)
            .$if(marked.length > 0, (query) => query.where("input_id", "not in", marked)),
        );
        return commitResult(true);
      }
      const session = executeSqliteQueryTakeFirstSync(
        current.db,
        db
          .selectFrom("session_nodes")
          .select("current_session_id")
          .where("session_key", "=", input.sessionKey),
      );
      if (session?.current_session_id !== input.sessionId) {
        admit("transaction");
        return commitResult("runId" in input ? false : { kind: "stale" });
      }
      const query = db
        .selectFrom("session_pending_inputs")
        .select(["input_id", "run_id", "state", "message_json"])
        .where("session_key", "=", input.sessionKey)
        .where("session_id", "=", input.sessionId)
        .where("consumed_event_id", "is", null);
      const found = executeSqliteQuerySync(
        current.db,
        "runId" in input
          ? query.where("run_id", "=", input.runId).limit(2)
          : query.where("input_id", "in", [...input.inputIds]),
      ).rows;
      if ("runId" in input && found.length !== 1) {
        admit("transaction");
        return commitResult(false);
      }
      const byId = new Map(found.map((row) => [row.input_id, row]));
      const rows =
        "runId" in input
          ? found
          : input.inputIds.flatMap((id) => {
              const row = byId.get(id);
              return row ? [row] : [];
            });
      const active = "inputIds" in input ? rows.filter((row) => row.state !== "cancelled") : [];
      if (active.length) {
        admit("transaction");
        return commitResult({ kind: "active", inputIds: active.map((row) => row.input_id) });
      }
      // The host owns run liveness; authorize these exact rows before changing them.
      admit("transaction", {
        kind: "pending-input-withdrawal-candidates",
        inputIds: rows.map((row) => row.input_id),
      });
      for (const row of rows) {
        const message = parseSessionPendingInputMessage(row.message_json);
        if (row.state === "cancelled" && message.display === false) {
          continue;
        }
        const result = executeSqliteQuerySync(
          current.db,
          db
            .updateTable("session_pending_inputs")
            .set({
              state: "cancelled",
              message_json: JSON.stringify({ ...message, display: false }),
            })
            .where("input_id", "=", row.input_id)
            .where("session_key", "=", input.sessionKey)
            .where("session_id", "=", input.sessionId)
            .where("consumed_event_id", "is", null),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error("Pending input withdrawal changed during its transaction");
        }
      }
      return commitResult(
        "runId" in input
          ? true
          : {
              kind: "dismissed",
              inputIds: rows.map((row) => row.input_id),
              runIds: rows.map((row) => row.run_id),
              missingIds: input.inputIds.filter((id) => !byId.has(id)),
            },
      );
    },
    options,
    { operationLabel: "session.pending-input.withdraw" },
  );
}
