import type { DecisionBatchResultV2, DecisionBatchV2 } from "./types-v2.js";
import type { DecisionBatch, DecisionBatchResult } from "./types.js";
import { finiteJson } from "./validation-common.js";
import { validateDecisionBatchV2, validateDecisionResultV2 } from "./validation-v2.js";
import {
  DecisionContractError,
  validateDecisionBatch,
  validateDecisionResult,
} from "./validation.js";

/** Malformed input throws; unsupported size or unrepresentable data returns undefined. */
export function decisionBatchV1ToV2(batch: DecisionBatch): DecisionBatchV2 | undefined {
  // Reject executable/proxy input before the legacy validator or any property access.
  if (finiteJson(batch, undefined, true) === "invalid") {
    throw new DecisionContractError();
  }
  if (!validateDecisionBatch(batch)) {
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

/** Never sends native-only inputs to V1, or changes explicit JSON strings into text. */
export function decisionBatchV2ToV1(batch: DecisionBatchV2): DecisionBatch | undefined {
  if (!validateDecisionBatchV2(batch)) {
    return undefined;
  }
  if (batch.state.type !== "text" && batch.state.type !== "json") {
    return undefined;
  }
  if (Object.values(batch.questions).some((q) => q.type === "sort" || q.type === "tags")) {
    return undefined;
  }
  const state = batch.state.type === "text" ? batch.state.text : batch.state.value;
  if (batch.state.type === "json" && state !== null && typeof state !== "object") {
    return undefined;
  }
  const converted = { state, questions: batch.questions };
  return validateDecisionBatch(converted) ? converted : undefined;
}

/** Preserve provider estimates and labels verbatim; never threshold or take an argmax. */
export function decisionResultV1ToV2(
  batch: DecisionBatch,
  result: DecisionBatchResult,
): DecisionBatchResultV2 | undefined {
  const v2Batch = decisionBatchV1ToV2(batch);
  if (
    !v2Batch ||
    finiteJson(result, undefined, true) !== "valid" ||
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
