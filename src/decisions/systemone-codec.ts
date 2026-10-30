import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { DecisionBatchV2 } from "./types-v2.js";

/** Callers admit their supported question kinds before encoding the wire names. */
export function encodeSystemOneQuestions(batch: DecisionBatchV2) {
  return Object.fromEntries(
    Object.entries(batch.questions).map(([id, question]) => [
      id,
      { ...question, type: question.type === "boolean" ? "noul" : question.type },
    ]),
  );
}

/** Decode native estimates without normalizing distributions or recomputing scores. */
export function decodeSystemOneResponse(batch: DecisionBatchV2, response: unknown): unknown {
  const root = asOptionalRecord(response);
  const answers = asOptionalRecord(root?.answers);
  const usage = asOptionalRecord(root?.usage);
  if (
    !root ||
    !answers ||
    !usage ||
    !Number.isSafeInteger(usage.input_tokens) ||
    !Number.isSafeInteger(usage.output_tokens) ||
    (root.provider !== undefined && typeof root.provider !== "string")
  ) {
    return undefined;
  }
  const converted = Object.fromEntries(
    Object.entries(answers).map(([id, value]) => {
      const answer = asOptionalRecord(value);
      const question = batch.questions[id];
      if (!answer) {
        return [id, undefined];
      }
      if (answer.type === "noul") {
        return [id, { type: "boolean", probabilityTrue: answer.noul }];
      }
      if (answer.type !== "choice" && answer.type !== "score" && answer.type !== "box") {
        return [id, undefined];
      }
      if (
        typeof answer.confidence !== "number" ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1
      ) {
        return [id, undefined];
      }
      if (answer.type === "box") {
        return [id, { type: "box", box: answer.box, confidence: answer.confidence }];
      }
      if (answer.type === "choice") {
        return [
          id,
          {
            type: "choice",
            choice: answer.choice,
            probabilities: answer.probabilities,
            confidence: answer.confidence,
          },
        ];
      }
      const probabilities = asOptionalRecord(answer.probabilities);
      if (
        question?.type !== "score" ||
        !probabilities ||
        Object.keys(probabilities).length !== question.criteria.length ||
        !question.criteria.every((_, index) => Object.hasOwn(probabilities, String(index)))
      ) {
        return [id, undefined];
      }
      // Wire score maps use zero-based rubric positions, not object insertion order.
      return [
        id,
        {
          type: "score",
          score: answer.score,
          probabilities: question.criteria.map((_, index) => probabilities[String(index)]),
          confidence: answer.confidence,
        },
      ];
    }),
  );
  return {
    model: root.model,
    answers: converted,
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
      ...(Object.keys(usage).some((key) => !["input_tokens", "output_tokens", "cost"].includes(key))
        ? { raw: usage }
        : {}),
    },
    ...(root.provider !== undefined ? { metadata: { provider: root.provider } } : {}),
  };
}
