/** Canonical route-capability schema for provider-owned manifest augmentation. */
export { ModelInferenceCapabilitiesSchema } from "../../packages/model-catalog-core/src/model-inference-capabilities.js";

export type {
  JsonValue,
  DecisionEntry,
  DecisionQuestion,
  DecisionBatch,
  DecisionAnswer,
  DecisionBatchResult,
  ProviderFailureReason,
  UnavailableReason,
  ProviderDecisionOutcome,
  DecisionOutcome,
  DecisionProviderV1,
  DecisionRuntimeV1,
} from "../decisions/types.js";

export type {
  DecisionContentV2,
  DecisionQuestionV2,
  DecisionBatchV2,
  DecisionAnswerV2,
  DecisionBatchResultV2,
  ProviderDecisionOutcomeV2,
  DecisionOutcomeV2,
  DecisionEvaluateOptionsV2,
  DecisionProviderV2,
  DecisionRuntimeV2,
} from "../decisions/types-v2.js";
export {
  decisionBatchV1ToV2,
  decisionBatchV2ToV1,
  decisionResultV1ToV2,
  decisionResultV2ToV1,
} from "../decisions/compatibility.js";
export { validateDecisionBatchV2, validateDecisionResultV2 } from "../decisions/validation-v2.js";
export { DecisionContractError } from "../decisions/validation.js";
export type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
