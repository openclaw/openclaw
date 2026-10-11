import { hasSessionQuestionCustodyRetiredError } from "../config/sessions/session-questions-custody-error.js";
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
    return await readSessionQuestionCustody(binding, observation.record.id, assertCurrent);
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
