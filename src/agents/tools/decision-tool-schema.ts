import { Type } from "typebox";

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
    contractVersion: {
      type: "integer",
      const: 2,
      description:
        "Use 2 for tagged state and native question types; omit for legacy text/JSON state.",
    },
    state: {
      ...entry,
      description:
        "With contractVersion 2: {type: 'text', text}, {type: 'json', value}, {type: 'image', dataUri, text?}, or {type: 'list', items: [{id, content}]}. Image dataUri is inline PNG/JPEG/WebP base64, at most 4 MiB decoded; provider limits also apply.",
    },
    questions: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        anyOf: [
          ...Object.entries(criteriaByQuestionType).map(([type, criteria]) => ({
            type: "object",
            additionalProperties: false,
            required: type === "boolean" ? ["type"] : ["type", "criteria"],
            properties: { type: { const: type }, instructions: entry, criteria },
          })),
          ...["sort", "box"].map((type) => ({
            type: "object",
            additionalProperties: false,
            required: type === "box" ? ["type", "instructions"] : ["type"],
            properties: {
              type: { const: type },
              instructions:
                type === "box"
                  ? { anyOf: entry.anyOf.filter((schema) => schema.type !== "null") }
                  : entry,
            },
          })),
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
});

export const DecisionEvaluateOutput = Type.Unsafe({
  type: "object",
  required: ["status"],
  properties: {
    status: { enum: ["ok", "unavailable"] },
    result: {
      type: "object",
      properties: {
        model: { type: "string" },
        answers: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              type: { enum: ["boolean", "choice", "score", "sort", "tags", "box", "error"] },
              answer: { type: ["boolean", "null"] },
              probabilityTrue: { type: "number" },
              choice: { type: ["string", "null"] },
              score: { type: "number" },
              probabilities: {
                anyOf: [
                  { type: "object", additionalProperties: { type: "number" } },
                  { type: "array", items: { type: "number" } },
                ],
              },
              probability: { type: ["number", "null"] },
              confidence: { type: ["number", "null"] },
              box: {
                type: "object",
                required: ["top", "bottom", "left", "right"],
                properties: Object.fromEntries(
                  ["top", "bottom", "left", "right"].map((edge) => [
                    edge,
                    { type: "number", minimum: 0, maximum: 1 },
                  ]),
                ),
              },
              order: { type: "array", items: { type: "string" } },
              tags: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "applies"],
                  properties: {
                    id: { type: "string" },
                    applies: { type: ["boolean", "null"] },
                    probability: { type: "number" },
                  },
                },
              },
              code: { enum: ["unsupported-input", "invalid-input", "provider-error"] },
              providerCode: { type: "string" },
              metadata: { type: "object", additionalProperties: true },
            },
          },
        },
        usage: {
          type: "object",
          properties: {
            inputTokens: { type: "number" },
            outputTokens: { type: "number" },
            costUsd: { type: "number" },
            units: {
              type: "object",
              properties: {
                unit: { enum: ["decision-units", "requests"] },
                amount: { type: "number" },
              },
            },
            raw: {},
          },
        },
        metadata: { type: "object", additionalProperties: true },
      },
    },
    provenance: { type: "object" },
    reason: { type: "string" },
    guidance: { type: "string" },
  },
});
