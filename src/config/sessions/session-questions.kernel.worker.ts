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
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import { hasQuestionOwnerNativeReference } from "./session-question-recovery-owner.js";
import { SessionQuestionCustodyRetiredError } from "./session-questions-custody-error.js";
import { matchesDurableQuestionDefinition } from "./session-questions-definition.js";
import { retireSessionQuestionsInDatabase } from "./session-questions-retirement.worker.js";
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

function assertQuestionGeneration(database: OpenClawAgentDatabase, question: DurableQuestion) {
  const fresh = readSessionEntryRow(database, question.sessionKey)?.entry;
  if (
    fresh?.sessionId !== question.sessionId ||
    fresh.lifecycleRevision !== question.lifecycleRevision
  ) {
    throw new Error("Question session changed; start a new question in the current session.");
  }
}

/** Called only inside the canonical worker's synchronous transaction and current host grant. */
export function operateSessionQuestion(
  database: OpenClawAgentDatabase,
  input: SessionQuestionOperation,
): SessionQuestionResult {
  const query = questionKysely(database);
  if (input.kind === "register") {
    assertCapturedQuestionBinding(database, input.question.sessionBinding);
  }
  if (input.kind === "register" || input.kind === "interrupt") {
    executeSqliteQuerySync(
      database.db,
      query
        .deleteFrom("session_questions")
        .where("continuation_state", "in", ["settled", "blocked", "interrupted"])
        .where("terminal_at", "<=", Date.now() - TERMINAL_RECEIPT_RETENTION_MS),
    );
  }
  if (input.kind === "retire") {
    const fresh = readSessionEntryRow(database, input.sessionKey)?.entry;
    if (
      fresh?.sessionId === input.sessionId &&
      fresh.lifecycleRevision === input.lifecycleRevision
    ) {
      throw new Error("Question generation is still active and cannot be retired.");
    }
    return retireSessionQuestionsInDatabase(database, input, input.resolutionId)
      .map((id) => readQuestion(database, id))
      .filter((question): question is DurableQuestion => question !== undefined);
  }
  if (input.kind === "list" || input.kind === "interrupt") {
    if (input.kind === "interrupt") {
      const pending = executeSqliteQuerySync(
        database.db,
        query
          .selectFrom("session_questions")
          .selectAll()
          .where("continuation_state", "in", ["pending", "owed", "claimed"]),
      ).rows;
      for (const row of pending) {
        const fresh = readSessionEntryRow(database, row.session_key)?.entry;
        if (
          fresh?.sessionId !== row.session_id ||
          fresh.lifecycleRevision !== row.lifecycle_revision
        ) {
          retireSessionQuestionsInDatabase(
            database,
            {
              sessionKey: row.session_key,
              sessionId: row.session_id,
              lifecycleRevision: row.lifecycle_revision,
            },
            `retired:${row.question_id}`,
          );
        }
      }
      executeSqliteQuerySync(
        database.db,
        query
          .updateTable("session_questions")
          .set({
            continuation_state: "interrupted",
            terminal_at: Date.now(),
            continuation_reason:
              "Gateway stopped after continuation admission; review the interrupted run before starting another.",
          })
          .where("continuation_state", "=", "claimed")
          .where("gateway_epoch", "!=", input.gatewayEpoch),
      );
    }
    return executeSqliteQuerySync(
      database.db,
      query.selectFrom("session_questions").selectAll(),
    ).rows.map(decodeQuestion);
  }
  const id = input.kind === "register" ? input.question.record.id : input.id;
  const current =
    input.kind === "settle" ||
    input.kind === "claim" ||
    input.kind === "finish" ||
    input.kind === "block"
      ? readCapturedQuestionMutationCustody(database, id, input.expectedQuestion)
      : readQuestion(database, id);
  if (input.kind === "get") {
    return current;
  }
  if (input.kind === "register") {
    const question = input.question;
    if (
      question.record.status !== "pending" ||
      question.continuation.status !== "pending" ||
      !question.lifecycleRevision ||
      question.record.agentId !== database.agentId ||
      question.record.sessionKey !== question.sessionKey ||
      question.record.answers ||
      question.resolutionId
    ) {
      throw new Error(
        "Durable question requires a pending definition and exact session ownership.",
      );
    }
    const binding = question.sessionBinding;
    if (
      binding.agentId !== database.agentId ||
      binding.sessionKey !== question.sessionKey ||
      binding.sessionId !== question.sessionId ||
      binding.lifecycleRevision !== question.lifecycleRevision ||
      binding.databasePath !== database.path
    ) {
      throw new Error(
        "Durable question binding does not own this database and session generation.",
      );
    }
    assertQuestionGeneration(database, question);
    if (current) {
      if (!matchesDurableQuestionDefinition(current, question)) {
        throw new Error("Question ID is already owned by another immutable definition.");
      }
      return current;
    }
    const fresh = readSessionEntryRow(database, question.sessionKey)?.entry;
    if (
      fresh?.durableQuestionOwners?.some(
        (owner) => owner.questionId === id && hasQuestionOwnerNativeReference(fresh, owner),
      )
    ) {
      throw new Error("Question ID is retained by native recovery; use a new question ID.");
    }
    const pending = executeSqliteQueryTakeFirstSync(
      database.db,
      query
        .selectFrom("session_questions")
        .select("question_id")
        .where("session_key", "=", question.sessionKey)
        .where("session_id", "=", question.sessionId)
        .where("lifecycle_revision", "=", question.lifecycleRevision)
        .where("continuation_state", "=", "pending"),
    );
    if (pending) {
      throw new Error(
        "This session already has a pending question; resolve it before asking another.",
      );
    }
    const count =
      executeSqliteQueryTakeFirstSync(
        database.db,
        query.selectFrom("session_questions").select(({ fn }) => fn.countAll<number>().as("count")),
      )?.count ?? 0;
    if (count >= 4096) {
      throw new Error(
        "Too many retained questions; resolve pending questions or wait for terminal receipts to expire before asking another.",
      );
    }
    executeSqliteQuerySync(
      database.db,
      query.insertInto("session_questions").values({
        question_id: id,
        session_key: question.sessionKey,
        session_id: question.sessionId,
        lifecycle_revision: question.lifecycleRevision,
        definition_json: JSON.stringify(question.record),
        provenance_json: JSON.stringify(question.provenance),
        session_binding_json: JSON.stringify(question.sessionBinding),
        result_json: null,
        resolution_id: null,
        continuation_state: "pending",
        continuation_run_id: null,
        gateway_epoch: null,
        terminal_at: null,
        continuation_reason: null,
      }),
    );
    recordQuestionOwner(database, question);
    return question;
  }
  if (!current) {
    throw new Error("Question not found; refresh the question list.");
  }
  if (input.kind !== "finish") {
    assertQuestionGeneration(database, current);
  }
  if (input.kind === "settle") {
    if (current.record.status !== "pending") {
      return current;
    }
    if (input.outcome.id !== id || !input.resolutionId) {
      throw new Error("Question resolution must name its original question and receipt.");
    }
    const expired = current.record.expiresAtMs <= Date.now();
    if (input.outcome.status === "expired" && !expired) {
      throw new Error("Question has not reached its absolute expiry.");
    }
    const outcome = expired
      ? { id, status: "expired" as const }
      : { ...input.outcome, ...(input.resolvedBy ? { resolvedBy: input.resolvedBy } : {}) };
    executeSqliteQuerySync(
      database.db,
      query
        .updateTable("session_questions")
        .set({
          result_json: JSON.stringify(outcome),
          resolution_id: input.resolutionId,
          continuation_state: "owed",
        })
        .where("question_id", "=", id)
        .where("continuation_state", "=", "pending"),
    );
  } else if (input.kind === "block") {
    if (current.continuation.status === "owed") {
      executeSqliteQuerySync(
        database.db,
        query
          .updateTable("session_questions")
          .set({
            continuation_state: "blocked",
            continuation_reason: input.reason,
            terminal_at: Date.now(),
          })
          .where("question_id", "=", id)
          .where("continuation_state", "=", "owed"),
      );
    }
  } else if (input.kind === "claim") {
    if (
      current.continuation.status === "claimed" &&
      current.continuation.runId === input.runId &&
      current.continuation.gatewayEpoch === input.gatewayEpoch
    ) {
      return current;
    }
    if (current.continuation.status !== "owed" || !input.runId || !input.gatewayEpoch) {
      throw new Error(
        "Question continuation is not available for admission; inspect its current outcome.",
      );
    }
    executeSqliteQuerySync(
      database.db,
      query
        .updateTable("session_questions")
        .set({
          continuation_state: "claimed",
          continuation_run_id: input.runId,
          gateway_epoch: input.gatewayEpoch,
        })
        .where("question_id", "=", id)
        .where("continuation_state", "=", "owed"),
    );
  } else {
    if (current.continuation.runId !== input.runId) {
      throw new Error("Question continuation no longer owns this run.");
    }
    if (current.continuation.status === "claimed") {
      executeSqliteQuerySync(
        database.db,
        query
          .updateTable("session_questions")
          .set({
            continuation_state: input.interrupted ? "interrupted" : "settled",
            terminal_at: Date.now(),
            continuation_reason: input.reason ?? null,
          })
          .where("question_id", "=", id)
          .where("continuation_state", "=", "claimed")
          .where("continuation_run_id", "=", input.runId),
      );
    }
  }
  const result = readQuestion(database, id);
  if (input.kind === "claim" && result) {
    recordQuestionOwner(database, result);
  }
  return result;
}

/** This marker remains bounded when the separate terminal question receipt expires. */
function recordQuestionOwner(database: OpenClawAgentDatabase, question: DurableQuestion): void {
  const fresh = readSessionEntryRow(database, question.sessionKey)?.entry;
  assertQuestionGeneration(database, question);
  if (!fresh) {
    throw new Error("Question lost its current session before ownership publication.");
  }
  const owners = (fresh.durableQuestionOwners ?? []).filter((owner) => {
    if (owner.questionId === question.record.id || hasQuestionOwnerNativeReference(fresh, owner)) {
      return true;
    }
    const retained = readQuestion(database, owner.questionId);
    return (
      retained !== undefined &&
      ["pending", "owed", "claimed"].includes(retained.continuation.status)
    );
  });
  const existing = owners.find((owner) => owner.questionId === question.record.id);
  if (!existing && owners.length >= 4096) {
    throw new Error(
      "Too many retained question recovery owners; finish recovery or start a new session before asking another.",
    );
  }
  if (
    existing &&
    hasQuestionOwnerNativeReference(fresh, existing) &&
    (existing.sourceRunId !== question.provenance.sourceRunId ||
      (existing.continuationRunId !== undefined &&
        question.continuation.runId !== undefined &&
        existing.continuationRunId !== question.continuation.runId))
  ) {
    throw new Error("Question recovery ownership cannot replace a retained native run.");
  }
  const owner = {
    questionId: question.record.id,
    sourceRunId: question.provenance.sourceRunId,
    ...(question.continuation.runId ? { continuationRunId: question.continuation.runId } : {}),
    sessionId: question.sessionId,
    lifecycleRevision: question.lifecycleRevision,
  };
  writeSessionEntry(
    database,
    question.sessionKey,
    {
      ...fresh,
      durableQuestionOwners: [
        ...owners.filter((prior) => prior.questionId !== owner.questionId),
        owner,
      ],
    },
    { canonicalPreviousEntry: fresh, questionOwnerMutation: true },
  );
}

/** Native mutation admission binds the captured observation, never a same-ID successor. */
function readCapturedQuestionMutationCustody(
  database: OpenClawAgentDatabase,
  id: string,
  expected: DurableQuestion,
): DurableQuestion {
  if (!expected?.sessionBinding || !expected.record) {
    throw new SessionQuestionCustodyRetiredError("Captured durable question custody is required.");
  }
  const current = readSessionQuestionCustodyInDatabase(database, expected.sessionBinding, id);
  const pendingDefinition: DurableQuestion = {
    ...expected,
    record: { ...expected.record, status: "pending" },
  };
  if (
    !current ||
    expected.record.id !== id ||
    !matchesDurableQuestionDefinition(current, pendingDefinition) ||
    current.record.createdAtMs !== expected.record.createdAtMs ||
    current.record.expiresAtMs !== expected.record.expiresAtMs
  ) {
    throw new SessionQuestionCustodyRetiredError(
      "Captured durable question definition or owner was retired.",
    );
  }
  return current;
}
