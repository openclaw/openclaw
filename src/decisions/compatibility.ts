import { DecisionContractError } from "./contract-error.js";
import type { DecisionEntry } from "./input-types.js";
import { validateDecisionBatchV2 } from "./input-validation.js";
import { validateDecisionResultV2 } from "./result-validation.js";
import type { DecisionBatchResultV2, DecisionBatchV2 } from "./types-v2.js";
import type { DecisionBatch, DecisionBatchResult } from "./types.js";
import { finiteJson } from "./validation-common.js";
import {
  MAX_DECISION_V1_QUESTIONS,
  validateDecisionBatchShape,
  validateDecisionResult,
} from "./validation.js";

/** Malformed input throws; unsupported size or unrepresentable data returns undefined. */
export function decisionBatchV1ToV2(batch: unknown): DecisionBatchV2 | undefined {
  // Reject executable/proxy input before V1 shape checks or any property access.
  const shape = finiteJson(batch, { rejectProxies: true });
  if (shape === "invalid") {
    throw new DecisionContractError();
  }
  if (shape === "oversized" || !validateDecisionBatchShape(batch)) {
    return undefined;
  }
  const converted: DecisionBatchV2 = {
    state:
      typeof batch.state === "string"
        ? { type: "text", text: batch.state }
        : { type: "json", value: batch.state },
    questions: batch.questions,
  };
  return validateDecisionBatchV2(converted) ? converted : undefined;
}

type V1RepresentableBatch = DecisionBatchV2 & {
  readonly state:
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "json"; readonly value: Exclude<DecisionEntry, string> };
  readonly questions: DecisionBatch["questions"];
};

/** Validate V2 input and narrow to the losslessly representable V1 subset without conversion. */
export function isDecisionBatchV1Representable(batch: unknown): batch is V1RepresentableBatch {
  if (!validateDecisionBatchV2(batch)) {
    return false;
  }
  if (batch.state.type !== "text" && batch.state.type !== "json") {
    return false;
  }
  if (
    batch.state.type === "json" &&
    batch.state.value !== null &&
    typeof batch.state.value !== "object"
  ) {
    return false;
  }
  // V2 validates the same unwrapped JSON/criteria budget. Only kinds and count differ here.
  const questions = Object.values(batch.questions);
  return (
    questions.length <= MAX_DECISION_V1_QUESTIONS &&
    questions.every((q) => q.type === "boolean" || q.type === "choice" || q.type === "score")
  );
}

/** Never sends native-only inputs to V1, or changes explicit JSON strings into text. */
export function decisionBatchV2ToV1(batch: DecisionBatchV2): DecisionBatch | undefined {
  if (!isDecisionBatchV1Representable(batch)) {
    return undefined;
  }
  return {
    state: batch.state.type === "text" ? batch.state.text : batch.state.value,
    questions: batch.questions,
  };
}

/** Preserve provider estimates and labels verbatim; never threshold or take an argmax. */
export function decisionResultV1ToV2(
  batch: DecisionBatch,
  result: DecisionBatchResult,
): DecisionBatchResultV2 | undefined {
  const v2Batch = decisionBatchV1ToV2(batch);
  if (
    !v2Batch ||
    finiteJson(result, { rejectProxies: true }) !== "valid" ||
    !validateDecisionResult(batch, result)
  ) {
    return undefined;
  }
  return validateDecisionResultV2(v2Batch, result) ? result : undefined;
}

/** Narrow only losslessly: V1 cannot carry explicit decisions, errors, or extra usage/metadata. */
export function decisionResultV2ToV1(
  batch: DecisionBatchV2,
  result: DecisionBatchResultV2,
): DecisionBatchResult | undefined {
  const v1Batch = decisionBatchV2ToV1(batch);
  if (!v1Batch || !validateDecisionResultV2(batch, result) || result.metadata !== undefined) {
    return undefined;
  }
  if (
    result.usage !== undefined &&
    Object.keys(result.usage).some((key) => key !== "inputTokens" && key !== "outputTokens")
  ) {
    return undefined;
  }
  for (const answer of Object.values(result.answers)) {
    if (
      answer.type === "error" ||
      answer.type === "sort" ||
      answer.type === "tags" ||
      answer.type === "box" ||
      answer.metadata !== undefined
    ) {
      return undefined;
    }
    if (answer.type === "boolean") {
      if (answer.answer !== undefined) {
        return undefined;
      }
    } else if (
      answer.confidence === null ||
      (answer.type === "choice" && (answer.choice === null || answer.probability !== undefined)) ||
      (answer.type === "score" && answer.probabilities === undefined)
    ) {
      return undefined;
    }
  }
  // V1 requires a nonzero distribution. An all-zero V2 map is not repaired here.
  return validateDecisionResult(v1Batch, result) ? result : undefined;
}
