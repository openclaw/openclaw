import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  codeModeJournalIntentSchema,
  codeModeJournalJson,
  codeModeJournalOutcomeSchema,
  codeModeJournalStartSchema,
  decodeCodeModeJournal,
  encodeCodeModeJournal,
} from "./code-mode-journal.codec.js";
import {
  CODE_MODE_JOURNAL_LIMITS as limits,
  CODE_MODE_JOURNAL_VERSION,
  type CodeModeJournal,
  type CodeModeJournalKey,
  type CodeModeJournalStart,
  type CodeModeJournalCallIntent,
  type CodeModeJournalCallCompletion,
} from "./code-mode-journal.types.js";

export function readCodeModeJournalInDatabase(
  db: EngineConnection,
  key: CodeModeJournalKey,
): CodeModeJournal | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("session_code_mode_journal")
      .select(["record_json", "version", "tool_call_id"])
      .where("session_key", "=", key.sessionKey)
      .where("session_id", "=", key.sessionId)
      .where("execution_id", "=", key.executionId),
  );
  return row ? decodeStoredJournal(row, key) : undefined;
}

function decodeStoredJournal(
  row: { version: number; record_json: string; tool_call_id: string },
  key: CodeModeJournalKey,
): CodeModeJournal {
  if (row.version !== CODE_MODE_JOURNAL_VERSION) {
    throw new Error("Unsupported Code Mode journal version; preserve it for recovery");
  }
  const value = decodeCodeModeJournal(row.record_json);
  if (
    value.executionId !== key.executionId ||
    value.sessionKey !== key.sessionKey ||
    value.sessionId !== key.sessionId ||
    value.toolCallId !== row.tool_call_id
  ) {
    throw new Error("Code Mode journal identity does not match its storage key");
  }
  return value;
}

/** Bounded exact-session discovery; never enumerate another participant's session. */
export function listCodeModeJournalsInDatabase(
  db: EngineConnection,
  scope: Pick<CodeModeJournalKey, "sessionKey" | "sessionId">,
): CodeModeJournal[] {
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("session_code_mode_journal")
      .select(["execution_id", "record_json", "version", "tool_call_id"])
      .where("session_key", "=", scope.sessionKey)
      .where("session_id", "=", scope.sessionId)
      .orderBy("execution_id")
      .limit(limits.executionsPerSession + 1),
  ).rows;
  if (rows.length > limits.executionsPerSession) {
    throw new Error("Code Mode journal count exceeds limit");
  }
  return rows.map((row) => {
    const key = { ...scope, executionId: row.execution_id };
    return decodeStoredJournal(row, key);
  });
}

function writeJournal(db: EngineConnection, journal: CodeModeJournal, insert = false): void {
  if (!db.isTransaction) {
    throw new Error("Code Mode journal requires its owning transaction");
  }
  const record = encodeCodeModeJournal(journal);
  withSqliteDatabaseWriteScope(db, [journal.sessionKey], () => {
    const query = getNodeSqliteKysely<DB>(db);
    executeSqliteQuerySync(
      db,
      insert
        ? query.insertInto("session_code_mode_journal").values({
            session_key: journal.sessionKey,
            session_id: journal.sessionId,
            execution_id: journal.executionId,
            tool_call_id: journal.toolCallId,
            version: journal.version,
            record_json: record,
          })
        : query
            .updateTable("session_code_mode_journal")
            .set({ record_json: record })
            .where("session_key", "=", journal.sessionKey)
            .where("session_id", "=", journal.sessionId)
            .where("execution_id", "=", journal.executionId),
    );
  });
}

export function beginCodeModeJournalInDatabase(
  db: EngineConnection,
  input: CodeModeJournalStart,
): CodeModeJournal {
  const parsed = codeModeJournalStartSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Invalid Code Mode journal start");
  }
  const previous = readCodeModeJournalInDatabase(db, parsed.data);
  if (previous) {
    const { calls: _calls, outcome: _outcome, ...start } = previous;
    if (!isDeepStrictEqual(start, parsed.data)) {
      throw new Error("Code Mode execution identity was reused with different inputs");
    }
    return previous;
  }
  // Refuse stale window publication; a window id is not authority to resume an old turn.
  const current = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("session_nodes")
      .select("current_session_id")
      .where("session_key", "=", input.sessionKey),
  );
  if (current?.current_session_id !== input.sessionId) {
    throw new Error("Code Mode session incarnation changed");
  }
  const count = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("session_code_mode_journal")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("session_key", "=", input.sessionKey),
  );
  if (Number(count?.count ?? 0) >= limits.executionsPerSession) {
    throw new Error("Code Mode active journal limit reached");
  }
  const journal: CodeModeJournal = { ...parsed.data, calls: [] };
  writeJournal(db, journal, true);
  return journal;
}

function requiredJournal(db: EngineConnection, key: CodeModeJournalKey): CodeModeJournal {
  const journal = readCodeModeJournalInDatabase(db, key);
  if (!journal) {
    throw new Error("Code Mode journal is missing; do not redispatch this execution");
  }
  return journal;
}

export function recordCodeModeCallInDatabase(
  db: EngineConnection,
  key: CodeModeJournalKey,
  input: CodeModeJournalCallIntent,
): CodeModeJournal {
  const parsed = codeModeJournalIntentSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Invalid Code Mode call intent");
  }
  const journal = requiredJournal(db, key);
  const previous = journal.calls.find((call) => call.key === input.key);
  if (previous) {
    // Compare only immutable intent fields; saved result bytes are never reconstructed.
    if (
      previous.operationId !== input.operationId ||
      previous.name !== input.name ||
      previous.argsJson !== input.argsJson ||
      previous.recovery !== input.recovery
    ) {
      throw new Error("Code Mode call diverged from its durable intent");
    }
    return journal;
  }
  if (journal.outcome) {
    throw new Error("Code Mode execution already finished");
  }
  if (journal.calls.length >= limits.callsPerExecution) {
    throw new Error("Code Mode call limit reached");
  }
  if (journal.calls.some((call) => call.operationId === input.operationId)) {
    throw new Error("Code Mode operation identity reused");
  }
  journal.calls.push({ ...parsed.data, state: "pending" });
  writeJournal(db, journal);
  return journal;
}

export function completeCodeModeCallInDatabase(
  db: EngineConnection,
  input: CodeModeJournalCallCompletion,
): CodeModeJournal {
  if (!codeModeJournalJson.safeParse(input.resultJson).success) {
    throw new Error("Invalid Code Mode call result");
  }
  const journal = requiredJournal(db, input);
  const index = journal.calls.findIndex((call) => call.key === input.key);
  const call = journal.calls[index];
  if (!call) {
    throw new Error("Code Mode call has no durable intent");
  }
  if (call.state === "completed") {
    if (call.resultJson !== input.resultJson || call.issuedCalls !== input.issuedCalls) {
      throw new Error("Code Mode call already has a different durable result");
    }
    return journal;
  }
  if (journal.outcome) {
    throw new Error("Code Mode execution already finished");
  }
  if (!Number.isSafeInteger(input.issuedCalls) || input.issuedCalls !== journal.calls.length) {
    throw new Error("Code Mode completion must record the current issued-call count");
  }
  journal.calls[index] = {
    ...call,
    state: "completed",
    resultJson: input.resultJson,
    issuedCalls: input.issuedCalls,
    deliveryIndex: journal.calls.filter((row) => row.state === "completed").length,
  };
  writeJournal(db, journal);
  return journal;
}

export function finishCodeModeJournalInDatabase(
  db: EngineConnection,
  key: CodeModeJournalKey,
  outcome: NonNullable<CodeModeJournal["outcome"]>,
): CodeModeJournal {
  if (!codeModeJournalOutcomeSchema.safeParse(outcome).success) {
    throw new Error("Invalid Code Mode final result or store");
  }
  const journal = requiredJournal(db, key);
  if (journal.outcome) {
    if (!isDeepStrictEqual(journal.outcome, outcome)) {
      throw new Error("Code Mode execution already has a different outcome");
    }
    return journal;
  }
  journal.outcome = outcome;
  writeJournal(db, journal);
  return journal;
}

/** Called only by the authoritative tool-result append inside its transaction. */
export function retireCodeModeJournalForToolResult(
  db: EngineConnection,
  scope: Pick<CodeModeJournalKey, "sessionKey" | "sessionId">,
  toolCallId: string,
  result: Record<string, unknown>,
): void {
  if (!db.isTransaction) {
    throw new Error("Code Mode retirement requires transcript transaction");
  }
  const executionId =
    isRecord(result.details) && typeof result.details.durableExecutionId === "string"
      ? result.details.durableExecutionId
      : undefined;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("session_code_mode_journal")
      .select("execution_id")
      .where("session_key", "=", scope.sessionKey)
      .where("session_id", "=", scope.sessionId)
      .where(executionId ? "execution_id" : "tool_call_id", "=", executionId ?? toolCallId),
  );
  if (!row) {
    return;
  }
  const journal = requiredJournal(db, { ...scope, executionId: row.execution_id });
  if (!journal.outcome) {
    // A generic interrupted tool result must not erase unfinished replay evidence.
    return;
  }
  // The transcript writer is authoritative, including output-cap and hook
  // transformations. A terminal wait carries its original execution identity.
  withSqliteDatabaseWriteScope(db, [scope.sessionKey], () =>
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .deleteFrom("session_code_mode_journal")
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("execution_id", "=", row.execution_id),
    ),
  );
}
