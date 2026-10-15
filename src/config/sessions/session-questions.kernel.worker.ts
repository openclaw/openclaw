import { isDeepStrictEqual } from "node:util";
import type { Selectable } from "kysely";
import type { DurableQuestionSessionBinding } from "../../gateway/question-session-access.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import { SessionQuestionCustodyRetiredError } from "./session-questions-custody-error.js";
import type {
  DurableQuestion,
  SessionQuestionOperation,
  SessionQuestionResult,
} from "./session-questions.types.js";

const TERMINAL_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

const questionKysely = (database: Pick<OpenClawAgentDatabase, "db">) =>
  getNodeSqliteKysely<Pick<DB, "session_questions">>(database.db);

function parseQuestionContinuationStatus(value: string): DurableQuestion["continuation"]["status"] {
  switch (value) {
    case "pending":
    case "owed":
    case "claimed":
    case "settled":
    case "interrupted":
    case "blocked":
      return value;
    default:
      throw new Error(`Invalid durable question continuation state: ${value}`);
  }
}

function decodeQuestion(row: Selectable<DB["session_questions"]>): DurableQuestion {
  const record: DurableQuestion["record"] = JSON.parse(row.definition_json);
  const outcome = row.result_json ? JSON.parse(row.result_json) : undefined;
  return {
    record: outcome ? { ...record, ...outcome } : record,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    lifecycleRevision: row.lifecycle_revision,
    provenance: JSON.parse(row.provenance_json),
    sessionBinding: JSON.parse(row.session_binding_json),
    ...(row.resolution_id ? { resolutionId: row.resolution_id } : {}),
    ...(row.terminal_at !== null
      ? { retainUntilMs: row.terminal_at + TERMINAL_RECEIPT_RETENTION_MS }
      : {}),
    continuation: {
      status: parseQuestionContinuationStatus(row.continuation_state),
      ...(row.continuation_run_id ? { runId: row.continuation_run_id } : {}),
      ...(row.gateway_epoch ? { gatewayEpoch: row.gateway_epoch } : {}),
      ...(row.continuation_reason ? { reason: row.continuation_reason } : {}),
    },
  };
}

function readQuestion(
  database: Pick<OpenClawAgentDatabase, "db">,
  id: string,
): DurableQuestion | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    questionKysely(database)
      .selectFrom("session_questions")
      .selectAll()
      .where("question_id", "=", id),
  );
  return row &&
    (row.terminal_at === null || row.terminal_at + TERMINAL_RECEIPT_RETENTION_MS > Date.now())
    ? decodeQuestion(row)
    : undefined;
}

export function readSessionQuestions(
  database: OpenClawAgentReadOnlyDatabase,
  input: Extract<SessionQuestionOperation, { kind: "get" | "list" }>,
): SessionQuestionResult {
  if (!getAdmittedSqliteSchemaFacts(database.db)?.tables.has("session_questions")) {
    return input.kind === "list" ? [] : undefined;
  }
  if (input.kind === "get") {
    return readQuestion(database, input.id);
  }
  return executeSqliteQuerySync(
    database.db,
    questionKysely(database)
      .selectFrom("session_questions")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("terminal_at", "is", null),
          eb("terminal_at", ">", Date.now() - TERMINAL_RECEIPT_RETENTION_MS),
        ]),
      ),
  ).rows.map(decodeQuestion);
}

/** Read-only custody repair requires exact physical and session facts in one native snapshot. */
export function readSessionQuestionCustodyInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  binding: DurableQuestionSessionBinding,
  id: string,
): DurableQuestion | undefined {
  assertCapturedQuestionBinding(database, binding);
  const question = readQuestion(database, id);
  // Serialize first to normalize deeply omitted optional fields at the persisted boundary.
  const serializedBinding = JSON.stringify(binding);
  const persistedBinding: unknown = JSON.parse(serializedBinding);
  const serializedQuestionBinding = question ? JSON.stringify(question.sessionBinding) : undefined;
  const persistedQuestionBinding: unknown = serializedQuestionBinding
    ? JSON.parse(serializedQuestionBinding)
    : undefined;
  if (
    question &&
    (question.record.agentId !== binding.agentId ||
      question.record.sessionKey !== binding.sessionKey ||
      question.sessionKey !== binding.sessionKey ||
      question.sessionId !== binding.sessionId ||
      question.lifecycleRevision !== binding.lifecycleRevision ||
      !isDeepStrictEqual(persistedQuestionBinding, persistedBinding))
  ) {
    throw new SessionQuestionCustodyRetiredError(
      "Durable question custody binding does not match the committed owner.",
    );
  }
  return question;
}

function assertCapturedQuestionBinding(
  database: OpenClawAgentReadOnlyDatabase,
  binding: DurableQuestionSessionBinding,
): void {
  let source: ReturnType<typeof captureSessionEntryReadSource>;
  try {
    source = captureSessionEntryReadSource(database, undefined);
  } catch (cause) {
    throw new SessionQuestionCustodyRetiredError(
      "Durable question custody database identity changed.",
      { cause },
    );
  }
  if (
    source.agentId !== binding.agentId ||
    source.path !== binding.databasePath ||
    source.databaseIdentity !== binding.databaseIdentity.identity ||
    source.databaseBirthtime !== binding.databaseIdentity.birthtime
  ) {
    throw new SessionQuestionCustodyRetiredError(
      "Durable question custody database identity changed.",
    );
  }
  const row = readSessionEntryRow(database, binding.sessionKey);
  if (
    !row ||
    row.row.session_key !== binding.sessionKey ||
    row.entry.sessionId !== binding.sessionId ||
    row.entry.lifecycleRevision !== binding.lifecycleRevision ||
    row.entry.incognito
  ) {
    throw new SessionQuestionCustodyRetiredError(
      "Durable question custody session generation changed.",
    );
  }
}
