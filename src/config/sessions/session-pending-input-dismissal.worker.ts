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
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";

const RETIRED_PENDING_INPUT_STATES = ["interrupted", "cancelled"] as const;

export type RetiredPendingInputDismissal = {
  sessionKey: string;
  sessionId: string;
  inputIds: readonly string[];
};

export type RetiredPendingInputDismissalOutcome =
  | { kind: "dismissed"; inputIds: string[]; runIds: string[]; missingIds: string[] }
  | { kind: "active"; inputIds: string[] }
  | { kind: "stale" };

export type RetiredPendingInputDismissalCandidates = {
  kind: "retired-pending-input-dismissal-candidates";
  sessionKey: string;
  sessionId: string;
  inputIds: string[];
};

export type RetiredPendingInputDismissalReceipt = RetiredPendingInputDismissal & {
  kind: "session-retired-pending-input-dismissal";
  outcome: RetiredPendingInputDismissalOutcome;
};

type RetiredPendingInputRow = {
  input_id: string;
  run_id: string;
  state: string;
  message_json: string;
  consumed_event_id: string | null;
};

type DismissalPlan = {
  outcome: RetiredPendingInputDismissalOutcome;
  tombstones: { inputId: string; messageJson: string }[];
};

function planDismissal(
  database: OpenClawAgentDatabase["db"],
  input: RetiredPendingInputDismissal,
): DismissalPlan {
  if (!hasSessionPendingInputsSchema(database)) {
    return {
      outcome: { kind: "dismissed", inputIds: [], runIds: [], missingIds: [...input.inputIds] },
      tombstones: [],
    };
  }
  const db = getSessionKysely(database);
  const session = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_nodes")
      .select("current_session_id")
      .where("session_key", "=", input.sessionKey),
  );
  if (session?.current_session_id !== input.sessionId) {
    return { outcome: { kind: "stale" }, tombstones: [] };
  }
  const rows: RetiredPendingInputRow[] = executeSqliteQuerySync(
    database,
    db
      .selectFrom("session_pending_inputs")
      .select(["input_id", "run_id", "state", "message_json", "consumed_event_id"])
      .where("session_key", "=", input.sessionKey)
      .where("session_id", "=", input.sessionId)
      .where("input_id", "in", [...input.inputIds]),
  ).rows;
  const byId = new Map(rows.map((row) => [row.input_id, row]));
  const active = input.inputIds.filter((id) => {
    const row = byId.get(id);
    return row?.consumed_event_id == null && row?.state === "queued";
  });
  if (active.length) {
    return { outcome: { kind: "active", inputIds: active }, tombstones: [] };
  }
  const dismissed: RetiredPendingInputRow[] = [];
  const missingIds: string[] = [];
  const tombstones: DismissalPlan["tombstones"] = [];
  for (const id of input.inputIds) {
    const row = byId.get(id);
    if (!row || row.consumed_event_id != null) {
      missingIds.push(id);
      continue;
    }
    dismissed.push(row);
    const message = parseSessionPendingInputMessage(row.message_json);
    if (row.state !== "cancelled" || message.display !== false) {
      tombstones.push({
        inputId: row.input_id,
        messageJson: JSON.stringify({ ...message, display: false }),
      });
    }
  }
  return {
    outcome: {
      kind: "dismissed",
      inputIds: dismissed.map((row) => row.input_id),
      runIds: dismissed.map((row) => row.run_id),
      missingIds,
    },
    tombstones,
  };
}

/** Tombstone retired custody like a withdrawal; the row and its receipt stay as the replay fence. */
export function dismissRetiredSessionPendingInputsInWorker(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: RetiredPendingInputDismissal,
  admit: (stage: "transaction" | "commit", publication?: unknown) => void,
): RetiredPendingInputDismissalOutcome {
  return runOpenClawAgentWriteTransaction(
    (current) => {
      if (current.db !== database.db) {
        throw new Error("Retired pending input dismissal lost its canonical database owner");
      }
      const schema =
        getPostgresPhysicalFacts(current.db) ?? getAdmittedSqliteSchemaFacts(current.db);
      if (!schema) {
        throw new Error("Retired pending input dismissal requires admitted schema facts");
      }
      const { outcome, tombstones } = planDismissal(current.db, input);
      const candidates: RetiredPendingInputDismissalCandidates = {
        kind: "retired-pending-input-dismissal-candidates",
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
        inputIds: tombstones.map((tombstone) => tombstone.inputId),
      };
      admit("transaction", candidates);
      const db = getSessionKysely(current.db);
      for (const tombstone of tombstones) {
        const result = executeSqliteQuerySync(
          current.db,
          db
            .updateTable("session_pending_inputs")
            .set({ state: "cancelled", message_json: tombstone.messageJson })
            .where("input_id", "=", tombstone.inputId)
            .where("session_key", "=", input.sessionKey)
            .where("session_id", "=", input.sessionId)
            .where("consumed_event_id", "is", null)
            .where("state", "in", [...RETIRED_PENDING_INPUT_STATES]),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error("Retired pending input dismissal changed during its transaction");
        }
      }
      const receipt: RetiredPendingInputDismissalReceipt = {
        kind: "session-retired-pending-input-dismissal",
        ...input,
        outcome,
      };
      deferSqliteWorkerCommitReceipt(current.db, receipt);
      admit("commit", receipt);
      return outcome;
    },
    options,
    { operationLabel: "session.pending-input.dismiss-retired" },
  );
}
