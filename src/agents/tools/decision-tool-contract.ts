import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { DecisionBatch, DecisionOutcome } from "../../decisions/types.js";
import { validateDecisionBatch } from "../../decisions/validation.js";
import type { DecisionProviderCapabilities } from "../../plugins/manifest-types.js";
import { textResult } from "./tool-results.js";

const entry = {
  anyOf: [
    { type: "string" },
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "null" },
  ],
} as const;

const criteriaByQuestionType = {
  boolean: {
    anyOf: [
      { type: "null" },
      {
        type: "object",
        properties: { true: entry, false: entry },
        additionalProperties: false,
      },
    ],
  },
  choice: { type: "object", minProperties: 2, additionalProperties: entry },
  score: { type: "array", minItems: 2, items: entry },
};

/** Provider-neutral request contract. Provider-specific translation stays in the provider plugin. */
export const DecisionEvaluateInput = Type.Unsafe({
  type: "object",
  additionalProperties: false,
  required: ["state", "questions"],
  properties: {
    state: entry,
    images: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string", minLength: 1 },
      description:
        "Optional local image paths already available to this agent. Remote URLs are not accepted.",
    },
    questions: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        anyOf: Object.entries(criteriaByQuestionType).map(([type, criteria]) => ({
          type: "object",
          additionalProperties: false,
          required: type === "boolean" ? ["type"] : ["type", "criteria"],
          properties: { type: { const: type }, instructions: entry, criteria },
        })),
      },
    },
  },
});

export const DecisionEvaluateOutput = Type.Unsafe({
  type: "object",
  required: ["status"],
  properties: {
    status: { enum: ["ok", "unavailable"] },
    result: { type: "object" },
    provenance: { type: "object" },
    reason: { type: "string" },
    guidance: { type: "string" },
  },
});

/** Validate before traversing the rubric; null means the shared resource guard rejected it. */
function parseDecisionEvaluateInput(value: unknown): DecisionBatch | null {
  try {
    if (!validateDecisionBatch(value)) {
      return null;
    }
    if (Object.keys(value).some((key) => key !== "state" && key !== "questions")) {
      throw new Error("Unexpected decision argument");
    }
    return value;
  } catch {
    throw new Error(
      "Invalid decision_evaluate input: provide state and a nonempty questions map with boolean, choice, or score questions; no evidence was sent.",
    );
  }
}

/** Tool references are resolved by the host before constructing a provider batch. */
function parseDecisionImageReferences(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 4 ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new Error("Invalid decision_evaluate images: provide one to four local image paths.");
  }
  const paths: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      !descriptor?.enumerable ||
      typeof descriptor.value !== "string" ||
      !descriptor.value.trim()
    ) {
      throw new Error("Invalid decision_evaluate images: provide one to four local image paths.");
    }
    paths.push(descriptor.value);
  }
  return paths;
}

export function parseDecisionEvaluateToolInput(value: unknown): {
  batch: DecisionBatch | null;
  imageRefs: string[];
} {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      throw new Error();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const stateDescriptor = descriptors.state;
    const questionsDescriptor = descriptors.questions;
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => key !== "state" && key !== "questions" && key !== "images",
      ) ||
      !stateDescriptor ||
      !questionsDescriptor ||
      !Object.hasOwn(stateDescriptor, "value") ||
      !Object.hasOwn(questionsDescriptor, "value") ||
      (descriptors.images && !Object.hasOwn(descriptors.images, "value"))
    ) {
      throw new Error();
    }
    return {
      batch: parseDecisionEvaluateInput({
        state: stateDescriptor.value,
        questions: questionsDescriptor.value,
      }),
      imageRefs: parseDecisionImageReferences(descriptors.images?.value),
    };
  } catch {
    throw new Error(
      "Invalid decision_evaluate input: provide state and a nonempty questions map with boolean, choice, or score questions; images, if present, must contain one to four local image paths; no evidence was sent.",
    );
  }
}

/** Identify the complete admitted rubric without including evidence in provenance. */
export function rubricVersion(batch: DecisionBatch): string {
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
export function capabilityGuidance(capabilities: DecisionProviderCapabilities): string {
  const limits = [
    capabilities.maxQuestions === undefined
      ? undefined
      : `at most ${capabilities.maxQuestions} questions`,
    capabilities.maxChoiceAlternatives === undefined
      ? undefined
      : `at most ${capabilities.maxChoiceAlternatives} Choice alternatives`,
    capabilities.maxScoreLevels === undefined
      ? undefined
      : `at most ${capabilities.maxScoreLevels} Score levels`,
    capabilities.maxInputTokens === undefined
      ? undefined
      : `at most ${capabilities.maxInputTokens} tokens ${capabilities.inputTokenScope === "encoded-question" ? "per encoded question (state and rubric together)" : capabilities.inputTokenScope === "state-plus-each-criterion" ? "per state-plus-criterion pair" : "per provider input (accounting scope undeclared)"}; shorten state or rubric if exceeded`,
  ].filter((value): value is string => value !== undefined);
  const boolean = capabilities.requiresBooleanCriteria
    ? " Boolean questions require both criteria.true and criteria.false descriptions."
    : "";
  const confidence =
    capabilities.confidence === "none"
      ? " This model does not report confidence."
      : capabilities.confidence === "provider-specific"
        ? " Optional confidence is a provider-specific distribution metric, not correctness probability."
        : "";
  const images = capabilities.inputModalities?.includes("image")
    ? " This model accepts local image evidence."
    : "";
  return `The selected provider supports ${capabilities.questionTypes.join(", ")} questions.${limits.length ? ` Limits: ${limits.join(", ")}.` : ""}${images}${boolean}${confidence}`;
}

const unavailableGuidance: Record<
  Extract<DecisionOutcome, { status: "unavailable" }>["reason"],
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
    "Shorten the state or rubric, reduce question counts or image sizes, and check the selected model's declared limits. Host bounds are 256 questions, 1 MiB of JSON, 20000 JSON nodes, depth 32, and up to four PNG/JPEG/WebP images (4 MiB each, 8 MiB total, 25 megapixels each). No evidence was truncated or sent on a host-bound rejection.",
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
  outcome: DecisionOutcome,
  capabilities?: DecisionProviderCapabilities,
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
