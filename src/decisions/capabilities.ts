import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import type { DecisionReasoning } from "./input-types.js";
import type { DecisionBatchV2 } from "./types-v2.js";

/** Facts used for input eligibility; route protocol, billing and grounding are host concerns. */
type DecisionInputCapabilities = Pick<
  ModelDecisionCapabilities,
  "input" | "questions" | "reasoning" | "limits"
>;

/** Match admitted evidence against the selected route without collecting more context. */
export function supportsDecisionInput(
  capability: DecisionInputCapabilities | undefined,
  batch: DecisionBatchV2,
  reasoning: DecisionReasoning | undefined,
): boolean {
  if (
    !capability ||
    !capability.input.includes(batch.state.type === "image" ? "image" : "text") ||
    (reasoning !== undefined && !capability.reasoning?.modes.includes(reasoning)) ||
    (capability.limits?.maxQuestions !== undefined &&
      Object.keys(batch.questions).length > capability.limits.maxQuestions)
  ) {
    return false;
  }
  if (batch.state.type === "image" && capability.limits?.image) {
    const image = capability.limits.image;
    const [prefix, payload = ""] = batch.state.dataUri.split(",", 2);
    const mime = prefix?.slice(5).split(";", 1)[0];
    if (
      !image.mimeTypes.some((allowed) => allowed === mime) ||
      Buffer.byteLength(payload, "base64") > image.maxBytes
    ) {
      return false;
    }
  }
  for (const question of Object.values(batch.questions)) {
    if (
      reasoning === "on" &&
      capability.reasoning?.questionTypes &&
      !capability.reasoning.questionTypes.includes(question.type)
    ) {
      return false;
    }
    const kind = capability.questions?.[question.type];
    if (!kind) {
      if (capability.questions) {
        return false;
      }
      continue;
    }
    if (
      question.type === "boolean" &&
      kind.requiresCriteria &&
      (question.criteria?.true == null || question.criteria.false == null)
    ) {
      return false;
    }
    const count =
      question.type === "choice" || question.type === "tags"
        ? Object.keys(question.criteria).length
        : question.type === "score"
          ? question.criteria.length
          : question.type === "sort" && batch.state.type === "list"
            ? batch.state.items.length
            : undefined;
    if (
      count !== undefined &&
      ((kind.minOptions !== undefined && count < kind.minOptions) ||
        (kind.maxOptions !== undefined && count > kind.maxOptions) ||
        (batch.state.type === "image" &&
          kind.maxImageOptions !== undefined &&
          count > kind.maxImageOptions))
    ) {
      return false;
    }
  }
  return true;
}
