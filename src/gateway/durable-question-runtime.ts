import type { SessionAccessScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import { matchesDurableQuestionDefinition } from "../config/sessions/session-questions-definition.js";
import {
  readSessionQuestionCustody,
  executeSessionQuestionOperation,
} from "../config/sessions/session-questions.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { QuestionManagerError, QuestionManagerErrorCodes } from "./question-manager.errors.js";
import { QuestionManager, type DurableQuestionCustody } from "./question-manager.js";
import type { QuestionRegistrationReservation } from "./question-registration-reservations.js";
import { createDurableQuestionSessionAccess } from "./question-session-durable-access.js";

/** Installs a committed worker fact; the Gateway map is only its current observation. */
export function installDurableQuestion(
  manager: QuestionManager,
  question: DurableQuestion,
  onContinuationOwed: (question: DurableQuestion) => void,
  publication?: Pick<Parameters<QuestionManager["request"]>[0], "onResolved">,
  reservation?: QuestionRegistrationReservation,
): void {
  reservation?.assertCurrent();
  const existing = manager.observe(question.record.id);
  if (existing) {
    if (
      !existing.durableDefinition ||
      existing.durableDefinition.record.createdAtMs !== question.record.createdAtMs ||
      existing.durableDefinition.record.expiresAtMs !== question.record.expiresAtMs ||
      !matchesDurableQuestionDefinition(existing.durableDefinition, {
        ...question,
        record: { ...question.record, status: "pending" },
      })
    ) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.ID_IN_USE,
        `question '${question.record.id}' already exists`,
      );
    }
    return;
  }
  let current = question;
  const scope = {
    agentId: question.record.agentId,
    sessionKey: question.sessionKey,
    storePath: question.sessionBinding.storePath,
  };
  const custody: DurableQuestionCustody = {
    definition: question,
    settle: async (outcome, assertCurrent, assertCustodyCurrent) => {
      const resolutionId =
        "resolutionId" in outcome && outcome.resolutionId
          ? outcome.resolutionId
          : `question:${question.record.id}:${outcome.status}`;
      const event =
        outcome.status === "answered"
          ? { id: question.record.id, status: outcome.status, answers: outcome.answers }
          : { id: question.record.id, status: outcome.status };
      let result;
      try {
        result = await executeSessionQuestionOperation(
          { ...scope, assertCurrent },
          {
            kind: "settle",
            expectedQuestion: question,
            id: question.record.id,
            outcome: event,
            resolutionId,
            resolvedBy: outcome.resolvedBy,
          },
        );
      } catch (error) {
        if (!hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        // Reconcile the same canonical target before deciding whether to retry.
        result = await readSessionQuestionCustody(
          question.sessionBinding,
          question.record.id,
          assertCustodyCurrent,
        );
        if (
          !result ||
          result.record.status === "pending" ||
          !matchesDurableQuestionDefinition(result, {
            ...question,
            record: { ...question.record, status: "pending" },
          })
        ) {
          throw error;
        }
      }
      if (!result || Array.isArray(result)) {
        throw new Error("Durable question settlement lost its canonical receipt");
      }
      current = result;
      return { record: result.record, resolutionId: result.resolutionId };
    },
    onContinuationOwed: () => {
      if (current.continuation.status === "owed") {
        onContinuationOwed(current);
      }
    },
  };
  manager.request({
    registrationReservation: reservation,
    id: question.record.id,
    questions: question.record.questions,
    agentId: question.record.agentId,
    sessionKey: question.sessionKey,
    runId: question.record.runId,
    timeoutMs: Math.max(1, question.record.expiresAtMs - question.record.createdAtMs),
    storedRecord: question.record,
    storedResolutionId: question.resolutionId,
    durableCustody: custody,
    sessionAccess: createDurableQuestionSessionAccess(question.sessionBinding),
    ...publication,
  });
  const observation = manager.observe(question.record.id);
  if (observation && question.retainUntilMs !== undefined) {
    manager.retireDurableObservationAt(observation, question.retainUntilMs);
  }
  if (question.continuation.status === "owed") {
    onContinuationOwed(question);
  }
}

/** Restore canonical questions independently of transcript retention and compaction. */
export async function recoverDurableQuestions(
  manager: QuestionManager,
  scopes: readonly SessionAccessScope[],
  onContinuationOwed: (question: DurableQuestion) => void,
  assertCurrent: () => void,
  publication?: (
    question: DurableQuestion,
  ) => Pick<Parameters<QuestionManager["request"]>[0], "onResolved">,
): Promise<void> {
  for (const scope of scopes) {
    const result = await executeSessionQuestionOperation(
      { ...scope, assertCurrent },
      { kind: "list" },
    );
    assertCurrent();
    if (!Array.isArray(result)) {
      throw new Error("Durable question recovery returned an invalid collection");
    }
    for (const question of result) {
      installDurableQuestion(manager, question, onContinuationOwed, publication?.(question));
    }
  }
}
