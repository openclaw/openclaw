import { DecisionContractError } from "./contract-error.js";
import type { DecisionBatch, DecisionBatchResult } from "./types.js";
import {
  decisionEntry,
  exactKeys,
  finiteJson,
  isPlainDecisionRecord,
  validDecisionCriteria,
} from "./validation-common.js";

export const MAX_DECISION_V1_QUESTIONS = 256;

/** Returns false only for locally unsupported resource size, never silently truncates. */
export function validateDecisionBatch(batch: unknown): batch is DecisionBatch {
  const shape = finiteJson(batch);
  if (shape === "invalid") {
    throw new DecisionContractError();
  }
  if (shape === "oversized") {
    return false;
  }
  return validateDecisionBatchShape(batch);
}

/** Internal V1 shape checks after finite JSON admission; callers retain their JSON policy. */
export function validateDecisionBatchShape(batch: unknown): batch is DecisionBatch {
  if (
    !isPlainDecisionRecord(batch) ||
    !decisionEntry(batch.state) ||
    !isPlainDecisionRecord(batch.questions)
  ) {
    throw new DecisionContractError();
  }
  const questions = Object.entries(batch.questions);
  if (!questions.length) {
    throw new DecisionContractError();
  }
  if (questions.length > MAX_DECISION_V1_QUESTIONS) {
    return false;
  }
  for (const [id, q] of questions) {
    if (
      !id ||
      !isPlainDecisionRecord(q) ||
      (q.instructions !== undefined && !decisionEntry(q.instructions))
    ) {
      throw new DecisionContractError();
    }
    if (
      (q.type !== "choice" && q.type !== "score" && q.type !== "boolean") ||
      !validDecisionCriteria(q.type, q.criteria)
    ) {
      throw new DecisionContractError();
    }
  }
  return true;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function distribution(values: unknown[]): values is number[] {
  return values.every(probability) && values.some((value) => value > 0);
}
/** Validate all answers before returning any; provider data never grants partial acceptance. */
export function validateDecisionResult(
  batch: Pick<DecisionBatch, "questions">,
  value: unknown,
): value is DecisionBatchResult {
  if (
    finiteJson(value) !== "valid" ||
    !isPlainDecisionRecord(value) ||
    typeof value.model !== "string" ||
    !value.model.length ||
    value.model.length > 256 ||
    !isPlainDecisionRecord(value.answers) ||
    !exactKeys(batch.questions, value.answers)
  ) {
    return false;
  }
  if (
    value.usage !== undefined &&
    (!isPlainDecisionRecord(value.usage) ||
      !Object.entries(value.usage).every(
        ([key, n]) =>
          (key === "inputTokens" || key === "outputTokens") &&
          typeof n === "number" &&
          Number.isFinite(n) &&
          n >= 0,
      ))
  ) {
    return false;
  }
  for (const [id, question] of Object.entries(batch.questions)) {
    const answer = value.answers[id];
    if (!isPlainDecisionRecord(answer) || answer.type !== question.type) {
      return false;
    }
    if (
      answer.confidence !== undefined &&
      (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence))
    ) {
      return false;
    }
    if (question.type === "boolean") {
      if (!probability(answer.probabilityTrue)) {
        return false;
      }
    } else if (question.type === "choice") {
      if (
        typeof answer.choice !== "string" ||
        !Object.hasOwn(question.criteria, answer.choice) ||
        !isPlainDecisionRecord(answer.probabilities) ||
        !exactKeys(question.criteria, answer.probabilities)
      ) {
        return false;
      }
      const values = Object.values(answer.probabilities);
      if (!distribution(values)) {
        return false;
      }
    } else {
      if (
        !Array.isArray(answer.probabilities) ||
        answer.probabilities.length !== question.criteria.length ||
        !distribution(answer.probabilities) ||
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1
      ) {
        return false;
      }
    }
  }
  return true;
}
