import { hasSessionQuestionCustodyRetiredError } from "../config/sessions/session-questions-custody-error.js";
import { matchesDurableQuestionDefinition } from "../config/sessions/session-questions-definition.js";
import { readSessionQuestionCustody } from "../config/sessions/session-questions.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import type { QuestionObservation } from "./question-manager.js";

/** Opt-in projection: old strict QuestionRecord consumers receive their original shape. */
export async function readDurableQuestionFact(
  observation: QuestionObservation,
  assertCurrent: () => void,
  retireObservation: () => void,
) {
  const binding = observation.sessionAccess?.durableBinding;
  if (!binding) {
    return undefined;
  }
  try {
    const current = await readSessionQuestionCustody(binding, observation.record.id, assertCurrent);
    const captured = observation.durableDefinition;
    if (
      current &&
      (!captured ||
        current.record.createdAtMs !== captured.record.createdAtMs ||
        current.record.expiresAtMs !== captured.record.expiresAtMs ||
        !matchesDurableQuestionDefinition(current, {
          ...captured,
          record: { ...captured.record, status: "pending" },
        }))
    ) {
      assertCurrent();
      retireObservation();
      return undefined;
    }
    return current;
  } catch (error) {
    if (!hasSessionQuestionCustodyRetiredError(error)) {
      throw error;
    }
    assertCurrent();
    retireObservation();
    return undefined;
  }
}

/** Opted modern clients can expose interrupted execution without changing legacy records. */
export function projectQuestionContinuationReceipt(result: DurableQuestion) {
  const { status, runId, reason } = result.continuation;
  return {
    questionId: result.record.id,
    status,
    ...(runId ? { runId } : {}),
    ...(reason ? { reason } : {}),
    ...(status === "blocked" || status === "interrupted"
      ? {
          nextAction: "Start a new user turn; this continuation was not automatically repeated.",
        }
      : {}),
  };
}
