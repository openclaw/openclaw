/** Canonical route-capability schema for provider-owned manifest augmentation. */
export { ModelInferenceCapabilitiesSchema } from "@openclaw/model-catalog-core/model-inference-capabilities";

export type { JsonValue, DecisionEntry, DecisionQuestion } from "../decisions/input-types.js";
export type { DecisionBatch, DecisionAnswer, DecisionBatchResult } from "../decisions/types.js";
export type {
  ProviderFailureReason,
  ProviderDecisionOutcome,
} from "../decisions/provider-outcomes.js";
export type { UnavailableReason, DecisionOutcome } from "../decisions/host-outcomes.js";
export type { DecisionProviderV1, DecisionProviderV2 } from "../decisions/provider-types.js";
export type { DecisionEvaluateOptionsV2 } from "../decisions/execution-types.js";
export type { DecisionRuntimeV1, DecisionRuntimeV2 } from "../decisions/runtime-types.js";

export type {
  DecisionContentV2,
  DecisionQuestionV2,
  DecisionBatchV2,
  DecisionAnswerV2,
  DecisionBatchResultV2,
} from "../decisions/types-v2.js";
export type { ProviderDecisionOutcomeV2 } from "../decisions/provider-outcomes.js";
export type { DecisionOutcomeV2 } from "../decisions/host-outcomes.js";
export {
  decisionBatchV1ToV2,
  decisionBatchV2ToV1,
  isDecisionBatchV1Representable,
  decisionResultV1ToV2,
  decisionResultV2ToV1,
} from "../decisions/compatibility.js";
export { validateDecisionBatchV2 } from "../decisions/input-validation.js";
export { validateDecisionResultV2 } from "../decisions/result-validation.js";
export { DecisionContractError } from "../decisions/contract-error.js";
export type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
export { encodeSystemOneQuestions, decodeSystemOneResponse } from "../decisions/systemone-codec.js";
