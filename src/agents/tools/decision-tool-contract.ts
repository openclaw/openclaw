import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { decisionBatchV1ToV2 } from "../../decisions/compatibility.js";
import type { DecisionOutcomeV2 } from "../../decisions/host-outcomes.js";
import { validateDecisionBatchV2 } from "../../decisions/input-validation.js";
import type { DecisionBatchV2 } from "../../decisions/types-v2.js";
import { isPlainDecisionRecord } from "../../decisions/validation-common.js";
import { textResult } from "./tool-results.js";

/** Validate before traversing the rubric; null means the shared resource guard rejected it. */
export function parseDecisionEvaluateInput(value: unknown): DecisionBatchV2 | null {
  try {
    if (isProxy(value) || !isPlainDecisionRecord(value)) {
      throw new Error("Unexpected decision argument");
    }
    // Inspect data descriptors before stripping the tool-only discriminator.
    // Getters, proxies and hidden arguments must not run or disappear before validation.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== "string" || !["state", "questions", "contractVersion"].includes(key),
      ) ||
      Object.values(descriptors).some(
        (descriptor) => !descriptor.enumerable || !Object.hasOwn(descriptor, "value"),
      )
    ) {
      throw new Error("Unexpected decision argument");
    }
    if (!descriptors.contractVersion) {
      return decisionBatchV1ToV2(value) ?? null;
    }
    if (descriptors.contractVersion.value !== 2) {
      throw new Error("Unexpected decision version");
    }
    const batch = { state: descriptors.state?.value, questions: descriptors.questions?.value };
    return validateDecisionBatchV2(batch) ? batch : null;
  } catch {
    throw new Error(
      "Invalid decision_evaluate input: provide state and a nonempty questions map. Use contractVersion 2 with tagged state for image, box, sort, or tags; no evidence was sent.",
    );
  }
}

/** Identify the complete admitted rubric without including evidence in provenance. */
export function rubricVersion(batch: DecisionBatchV2): string {
  const canonical = JSON.stringify(canonicalize(batch.questions));
  return `decision-v1-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

// Validation bounds recursion before canonicalization and preserves array order.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

/** Describe only declared provider limits; missing metadata never means unlimited. */
export function capabilityGuidance(capabilities: ModelDecisionCapabilities): string {
  const questionTypes = (["boolean", "choice", "score", "sort", "tags", "box"] as const).filter(
    (kind) => capabilities.questions?.[kind],
  );
  const declared = capabilities.limits;
  const limits = [
    ...(declared?.image
      ? [
          `images up to ${declared.image.maxBytes} decoded bytes in ${declared.image.mimeTypes.join(", ")}`,
        ]
      : []),
    declared?.maxQuestions === undefined ? undefined : `at most ${declared.maxQuestions} questions`,
    ...(["choice", "score"] as const).flatMap((kind) => {
      const bounds = capabilities.questions?.[kind];
      const unit = kind === "choice" ? "Choice alternatives" : "Score levels";
      return [
        bounds?.minOptions === undefined ? undefined : `at least ${bounds.minOptions} ${unit}`,
        bounds?.maxOptions === undefined ? undefined : `at most ${bounds.maxOptions} ${unit}`,
      ];
    }),
    declared?.maxRequestTokens === undefined
      ? undefined
      : `at most ${declared.maxRequestTokens} tokens per request`,
    declared?.maxStateAndQuestionTokens === undefined
      ? undefined
      : `at most ${declared.maxStateAndQuestionTokens} tokens per state-plus-question`,
    declared?.maxInputTokens === undefined
      ? undefined
      : `at most ${declared.maxInputTokens} tokens ${declared.inputTokenScope === "encoded-question" ? "per encoded question (state and rubric together)" : declared.inputTokenScope === "state-plus-each-criterion" ? "per state-plus-criterion pair" : "per provider input (accounting scope undeclared)"}; shorten state or rubric if exceeded`,
  ].filter((value): value is string => value !== undefined);
  const boolean = capabilities.questions?.boolean?.requiresCriteria
    ? " Boolean questions require both criteria.true and criteria.false descriptions."
    : "";
  const confidence =
    capabilities.confidence === "none"
      ? " This model does not report confidence."
      : capabilities.confidence === "provider-specific"
        ? " Optional confidence is a provider-specific distribution metric, not correctness probability."
        : "";
  const supported =
    capabilities.questions === undefined
      ? "The selected model's question types are undeclared."
      : questionTypes.length
        ? `The selected provider supports ${questionTypes.join(", ")} questions.`
        : "The selected model declares no supported question types.";
  return `${supported} Supported input modalities: ${capabilities.input.join(", ")}.${limits.length ? ` Limits: ${limits.join(", ")}.` : ""}${boolean}${confidence}`;
}

const unavailableGuidance: Record<
  Extract<DecisionOutcomeV2, { status: "unavailable" }>["reason"],
  string
> = {
  disabled:
    "Decision evaluation is disabled for this agent. Ask the operator to select a decisionModel or enable its provider.",
  "not-configured":
    "The selected decision provider is unavailable. Ask the operator to install and configure its plugin.",
  "credentials-unavailable":
    "The selected provider has no prepared credentials. Ask the operator to configure its credentials.",
  authentication:
    "The selected provider rejected authentication. Ask the operator to check its credentials.",
  "rate-limited":
    "The selected provider is rate limited. Try again later only if the evaluation is still needed.",
  transport:
    "The selected provider could not be reached. Check its service or endpoint before trying again.",
  "unsupported-input":
    "Shorten the state or rubric, reduce question counts, and check the selected model's declared limits. Host bounds are 256 questions for legacy input or 400 with contractVersion 2, 1 MiB of JSON, 20000 JSON nodes, and depth 32. No evidence was truncated or sent on a host-bound rejection.",
  "invalid-response":
    "The selected provider returned an invalid result. No answers were accepted; ask the operator to check its adapter or service.",
  retiring:
    "The selected provider is being replaced or stopped. Try again after the operator completes that change.",
  overloaded:
    "The selected provider is at capacity. Try again later only if the evaluation is still needed.",
  "circuit-open":
    "The selected provider is temporarily blocked after failures. Check its service before trying again later.",
  deadline:
    "The evaluation exceeded its deadline. Shorten the input or ask the operator to check provider performance.",
};

/** Preserve provider values and provenance; diagnostics contain only bounded local facts. */
export function decisionToolResult(
  outcome: DecisionOutcomeV2,
  capabilities?: ModelDecisionCapabilities,
) {
  const details =
    outcome.status === "unavailable"
      ? {
          ...outcome,
          guidance:
            unavailableGuidance[outcome.reason] +
            (outcome.reason === "unsupported-input" && capabilities
              ? ` ${capabilityGuidance(capabilities)}`
              : ""),
        }
      : outcome;
  return textResult(JSON.stringify(details), details);
}
