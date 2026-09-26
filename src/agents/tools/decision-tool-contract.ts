import { createHash } from "node:crypto";
import { Type } from "typebox";
import type {
  DecisionBatchV2,
  DecisionOutcomeV2,
  DecisionEvaluateOptionsV2,
} from "../../decisions/types-v2.js";
import type { DecisionBatch, DecisionOutcome } from "../../decisions/types.js";
import { finiteJson, record } from "../../decisions/validation-common.js";
import { validateDecisionBatchV2 } from "../../decisions/validation-v2.js";
import { validateDecisionBatch } from "../../decisions/validation.js";
import type { DecisionProviderCapabilities } from "../../plugins/manifest-types.js";

const entry = {
  anyOf: [
    { type: "string" },
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "null" },
  ],
} as const;

/** Provider-neutral request contract. Provider-specific translation stays in the provider plugin. */
const DecisionEvaluateInputV1 = {
  type: "object",
  additionalProperties: false,
  required: ["state", "questions"],
  properties: {
    state: entry,
    questions: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: {
              type: { const: "boolean" },
              instructions: entry,
              criteria: {
                anyOf: [
                  { type: "null" },
                  {
                    type: "object",
                    properties: { true: entry, false: entry },
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "criteria"],
            properties: {
              type: { const: "choice" },
              instructions: entry,
              criteria: { type: "object", minProperties: 2, additionalProperties: entry },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "criteria"],
            properties: {
              type: { const: "score" },
              instructions: entry,
              criteria: { type: "array", minItems: 2, items: entry },
            },
          },
        ],
      },
    },
  },
} as const;

const textContent = {
  type: "object",
  additionalProperties: false,
  required: ["type", "text"],
  properties: { type: { const: "text" }, text: { type: "string" } },
};
const jsonContent = {
  type: "object",
  additionalProperties: false,
  required: ["type", "value"],
  properties: { type: { const: "json" }, value: {} },
};
const imageContent = {
  type: "object",
  additionalProperties: false,
  required: ["type", "dataUri"],
  properties: {
    type: { const: "image" },
    dataUri: {
      type: "string",
      description: "Explicit PNG/JPEG/WebP base64 data URI; never a remote URL or file path.",
    },
    text: { type: "string" },
  },
};
const listContent = {
  type: "object",
  additionalProperties: false,
  required: ["type", "items"],
  properties: {
    type: { const: "list" },
    items: {
      type: "array",
      maxItems: 120,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "content"],
        properties: { id: { type: "string", minLength: 1 }, content: entry },
      },
    },
  },
};
const DecisionEvaluateInputV2 = {
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "state", "questions"],
  properties: {
    contractVersion: { const: 2 },
    reasoning: { enum: ["auto", "off", "on"] },
    state: { anyOf: [textContent, jsonContent, imageContent, listContent] },
    questions: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        anyOf: [
          ...DecisionEvaluateInputV1.properties.questions.additionalProperties.anyOf,
          {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: { type: { const: "sort" }, instructions: entry },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "criteria"],
            properties: {
              type: { const: "tags" },
              instructions: entry,
              criteria: { type: "object", minProperties: 1, additionalProperties: entry },
            },
          },
        ],
      },
    },
  },
};

export const DecisionEvaluateInput = Type.Unsafe({
  type: "object",
  anyOf: [DecisionEvaluateInputV1, DecisionEvaluateInputV2],
});

export type DecisionToolRequest =
  | { version: 1; batch: DecisionBatch }
  | { version: 2; batch: DecisionBatchV2; reasoning?: DecisionEvaluateOptionsV2["reasoning"] };

/** Version selection never executes caller getters or inspects unbounded evidence. */
export function parseDecisionToolRequest(value: unknown): DecisionToolRequest | null {
  const shape = finiteJson(value, 7 * 1_048_576, true);
  if (shape === "oversized") {
    return null;
  }
  if (shape !== "valid" || !record(value)) {
    throw new Error("Invalid decision_evaluate input; no evidence was sent.");
  }
  if (value.contractVersion !== 2) {
    const batch = parseDecisionEvaluateInput(value);
    return batch ? { version: 1, batch } : null;
  }
  if (
    Object.keys(value).some(
      (key) => !["contractVersion", "state", "questions", "reasoning"].includes(key),
    ) ||
    (value.reasoning !== undefined &&
      value.reasoning !== "auto" &&
      value.reasoning !== "off" &&
      value.reasoning !== "on")
  ) {
    throw new Error("Invalid decision_evaluate version 2 options; no evidence was sent.");
  }
  const batch = { state: value.state, questions: value.questions };
  if (!validateDecisionBatchV2(batch)) {
    return null;
  }
  return { version: 2, batch, ...(value.reasoning ? { reasoning: value.reasoning } : {}) };
}

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

/** Identify the complete admitted rubric without including evidence in provenance. */
export function rubricVersion(
  batch: Pick<DecisionBatch | DecisionBatchV2, "questions">,
  version: 1 | 2 = 1,
): string {
  const canonical = JSON.stringify(canonicalize(batch.questions));
  return `decision-v${version}-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
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
  return `The selected provider supports ${capabilities.questionTypes.join(", ")} questions.${limits.length ? ` Limits: ${limits.join(", ")}.` : ""}${boolean}${confidence}`;
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
    "Shorten the state or rubric, reduce question counts, and check the selected model's declared limits. Host bounds are 256 questions, 1 MiB of JSON, 20000 JSON nodes, and depth 32. No evidence was truncated or sent on a host-bound rejection.",
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
  outcome: DecisionOutcome | DecisionOutcomeV2,
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
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}
