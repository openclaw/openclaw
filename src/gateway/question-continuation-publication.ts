import { hasSessionQuestionCustodyRetiredError } from "../config/sessions/session-questions-custody-error.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import type { QuestionManager, QuestionObservation } from "./question-manager.js";
import { publishDurableQuestionResolution } from "./question-session-access.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

/** Publishes only the captured canonical receipt, never a same-ID successor. */
export function createQuestionContinuationPublication(params: {
  questionManager: QuestionManager;
  getContext: () => GatewayRequestContext | undefined;
  assertCurrent: () => void;
  warn: (message: string) => void;
}) {
  const { questionManager, assertCurrent: assertQuestionOwnerCurrent } = params;
  return async (question: DurableQuestion, observation: QuestionObservation | null) => {
    try {
      if (observation?.isCurrent()) {
        assertQuestionOwnerCurrent();
        const { readSessionQuestionCustody } =
          await import("../config/sessions/session-questions.js");
        const current = await readSessionQuestionCustody(
          question.sessionBinding,
          question.record.id,
          assertQuestionOwnerCurrent,
        );
        assertQuestionOwnerCurrent();
        if (observation.isCurrent() && !Array.isArray(current)) {
          if (!current) {
            questionManager.retireDurableObservationAt(observation, 0);
          } else if (
            current.sessionId === question.sessionId &&
            current.lifecycleRevision === question.lifecycleRevision &&
            current.provenance.sourceRunId === question.provenance.sourceRunId &&
            current.record.createdAtMs === question.record.createdAtMs
          ) {
            if (current.retainUntilMs !== undefined) {
              questionManager.retireDurableObservationAt(observation, current.retainUntilMs);
            }
            if (
              (current.continuation.status === "blocked" ||
                current.continuation.status === "interrupted") &&
              current.record.status !== "pending"
            ) {
              const context = params.getContext();
              assertQuestionOwnerCurrent();
              if (context) {
                if (current.record.status === "answered" && !current.record.answers) {
                  throw new Error("Canonical answered question is missing its saved answers.");
                }
                const event =
                  current.record.status === "answered"
                    ? {
                        id: current.record.id,
                        status: current.record.status,
                        answers: current.record.answers!,
                      }
                    : { id: current.record.id, status: current.record.status };
                await publishDurableQuestionResolution({
                  context,
                  event,
                  observation,
                  assertCurrent: assertQuestionOwnerCurrent,
                });
              }
            }
          }
        }
      }
    } catch (error) {
      if (observation && hasSessionQuestionCustodyRetiredError(error)) {
        questionManager.retireDurableCustodyObservation(observation);
        return;
      }
      params.warn(`durable question receipt retirement failed: ${String(error)}`);
    }
  };
}
