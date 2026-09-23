import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import type { DecisionProviderCapabilities } from "../plugins/manifest-types.js";
import type { DecisionBatch, DecisionInputIssue } from "./types.js";

export type DecisionInputEstimate = {
  method: "cjk-weighted-chars-v1";
  overhead: "heuristic";
  questionCount: number;
  criterionCount: number;
  estimatedMaxInputTokens: number;
  estimatedTotalInputTokens: number;
};

// Nonzero allowance for separators, encoder special tokens and request framing.
// This is deliberately a heuristic, not knowledge of any provider's tokenizer.
const FRAME_TOKENS = 16;
const CRITERION_TOKENS = 4;
const tokens = (value: unknown) =>
  estimateTokensFromChars(estimateStringChars(JSON.stringify(value)));

/** Only call after validateDecisionBatch has admitted the bounded, accessor-free batch. */
export function estimateDecisionInput(
  batch: DecisionBatch,
  scope: DecisionProviderCapabilities["inputTokenScope"],
): DecisionInputEstimate {
  const { state: evidence, questions: _questions, ...extra } = batch;
  const state = tokens(evidence) + tokens(extra);
  let maximum = 0;
  let total = state + FRAME_TOKENS;
  let criterionCount = 0;
  const questions = Object.entries(batch.questions);
  for (const [id, question] of questions) {
    const criteria =
      question.type === "boolean"
        ? Object.entries({ true: null, false: null, ...question.criteria })
        : Object.entries(question.criteria);
    criterionCount += criteria.length;
    const { criteria: _criteria, ...headerFields } = question;
    const header = tokens({ id, question: headerFields });
    const criterionSizes = criteria.map(
      ([label, value]) => tokens({ label, value }) + CRITERION_TOKENS,
    );
    const rubric = header + criterionSizes.reduce((sum, size) => sum + size, 0) + FRAME_TOKENS;
    total += rubric;
    const encoded =
      scope === "state-plus-each-criterion"
        ? header + Math.max(...criterionSizes) + FRAME_TOKENS
        : rubric;
    maximum = Math.max(maximum, state + encoded);
  }
  return {
    method: "cjk-weighted-chars-v1",
    overhead: "heuristic",
    questionCount: questions.length,
    criterionCount,
    estimatedMaxInputTokens: maximum,
    estimatedTotalInputTokens: Math.max(
      total,
      tokens(batch) +
        FRAME_TOKENS +
        questions.length * FRAME_TOKENS +
        criterionCount * CRITERION_TOKENS,
    ),
  };
}

/** Unknown is not unlimited: opted-in callers require both limits and their accounting scope. */
export function decisionInputBudgetIssue(
  capabilities: DecisionProviderCapabilities | undefined,
  estimate: DecisionInputEstimate,
): DecisionInputIssue | undefined {
  if (
    !capabilities?.maxInputTokens ||
    !capabilities.inputTokenScope ||
    !capabilities.maxTotalInputTokens
  ) {
    return "budget-unknown";
  }
  if (
    estimate.estimatedMaxInputTokens > capabilities.maxInputTokens ||
    estimate.estimatedTotalInputTokens > capabilities.maxTotalInputTokens
  ) {
    return "estimated-budget-exceeded";
  }
  return undefined;
}
