import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DecisionReasoning } from "./execution-types.js";
import type { DecisionAnswerV2, DecisionBatchV2, ProviderDecisionOutcomeV2 } from "./types-v2.js";
import type { DecisionEntry } from "./types.js";
import { validateDecisionBatchV2 } from "./validation-v2.js";

// Wire limits shared by native and router transports.
const maxQuestions = 400;
const maxChoiceAlternatives = 255;

function text(value: DecisionEntry | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

function questions(batch: DecisionBatchV2) {
  return Object.entries(batch.questions).map(([name, question]) => {
    const instructions = text(question.instructions);
    if (question.type === "boolean") {
      return {
        type: "predicate",
        name,
        instructions: question.criteria
          ? `${instructions}\nTrue criterion: ${text(question.criteria.true)}\nFalse criterion: ${text(question.criteria.false)}`
          : instructions,
      };
    }
    if (question.type === "choice") {
      return {
        type: "choice",
        name,
        instructions,
        choices: Object.entries(question.criteria).map(([value, description]) => ({
          value,
          description: text(description),
        })),
      };
    }
    if (question.type !== "score") {
      throw new Error("Unsupported OpenAI decision question");
    }
    return {
      type: "score",
      name,
      instructions,
      levels: question.criteria.map((description, index) => ({
        label: String(index),
        description: text(description),
      })),
    };
  });
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function decodeOpenAIDecisionResult(
  batch: DecisionBatchV2,
  payload: Record<string, unknown>,
): ProviderDecisionOutcomeV2 {
  const entries = Object.entries(batch.questions);
  if (
    typeof payload.model !== "string" ||
    !payload.model ||
    payload.model.length > 256 ||
    !Array.isArray(payload.answers) ||
    payload.answers.length !== entries.length
  ) {
    return { status: "unavailable", reason: "invalid-response" };
  }
  const answers: [string, DecisionAnswerV2][] = [];
  for (const [index, [name, question]] of entries.entries()) {
    const answer: unknown = payload.answers[index];
    if (!isRecord(answer) || answer.name !== name) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    // Refusals belong to one question; preserve independent successful answers.
    if (answer.type === "refusal") {
      answers.push([name, { type: "error", code: "provider-error", providerCode: "refusal" }]);
      continue;
    }
    if (question.type === "boolean") {
      if (answer.type !== "predicate" || !probability(answer.probability)) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      answers.push([name, { type: "boolean", probabilityTrue: answer.probability }]);
      continue;
    }
    if (question.type !== "choice" && question.type !== "score") {
      return { status: "unavailable", reason: "invalid-response" };
    }
    if (
      answer.type !== question.type ||
      !Array.isArray(answer.probabilities) ||
      typeof answer.confidence !== "number" ||
      !Number.isFinite(answer.confidence)
    ) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    const labels =
      question.type === "choice"
        ? Object.keys(question.criteria)
        : question.criteria.map((_, i) => String(i));
    const distribution = new Map<string, number>();
    for (const item of answer.probabilities) {
      const label = isRecord(item)
        ? item[question.type === "choice" ? "value" : "label"]
        : undefined;
      if (
        !isRecord(item) ||
        typeof label !== "string" ||
        !labels.includes(label) ||
        distribution.has(label) ||
        !probability(item.probability) ||
        (question.type === "score" && item.value !== Number(label))
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      distribution.set(label, item.probability);
    }
    if (
      distribution.size !== labels.length ||
      ![...distribution.values()].some((value) => value > 0)
    ) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !distribution.has(answer.choice)) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      answers.push([
        name,
        {
          type: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: Object.fromEntries(distribution),
        },
      ]);
    } else {
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > labels.length - 1
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      answers.push([
        name,
        {
          type: "score",
          score: answer.score,
          confidence: answer.confidence,
          probabilities: labels.map((label) => distribution.get(label)!),
        },
      ]);
    }
  }
  const usage = payload.usage;
  if (
    !isRecord(usage) ||
    typeof usage.input_tokens !== "number" ||
    !Number.isInteger(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    typeof usage.output_tokens !== "number" ||
    !Number.isInteger(usage.output_tokens) ||
    usage.output_tokens < 0
  ) {
    return { status: "unavailable", reason: "invalid-response" };
  }
  return {
    status: "ok",
    result: {
      model: payload.model,
      answers: Object.fromEntries(answers),
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      },
    },
  };
}

/** Validate before transport or credential-scoped discovery. Malformed caller data still throws. */
export function supportsOpenAIDecisionBatch(
  batch: DecisionBatchV2,
  reasoning: DecisionReasoning | undefined,
): batch is DecisionBatchV2 & {
  state: Exclude<DecisionBatchV2["state"], { type: "list" }>;
} {
  if (!validateDecisionBatchV2(batch)) {
    return false;
  }
  const entries = Object.values(batch.questions);
  return (
    (batch.state.type === "text" || batch.state.type === "json" || batch.state.type === "image") &&
    (reasoning === undefined || reasoning === "auto") &&
    entries.length <= maxQuestions &&
    entries.every((question) => ["boolean", "choice", "score"].includes(question.type)) &&
    entries.every(
      (question) =>
        question.type !== "choice" ||
        Object.keys(question.criteria).length <= maxChoiceAlternatives,
    )
  );
}

export function encodeOpenAIDecisionRequest(
  batch: DecisionBatchV2 & {
    state: Exclude<DecisionBatchV2["state"], { type: "list" }>;
  },
  modelId: string,
) {
  return {
    model: modelId,
    input:
      batch.state.type === "image"
        ? [
            {
              role: "user",
              content: [
                ...(batch.state.text ? [{ type: "input_text", text: batch.state.text }] : []),
                { type: "input_image", image_url: batch.state.dataUri },
              ],
            },
          ]
        : batch.state.type === "text"
          ? batch.state.text
          : JSON.stringify(batch.state.value),
    questions: questions(batch),
  };
}
