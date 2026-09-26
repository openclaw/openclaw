import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import type { DecisionBatchResultV2, DecisionBatchV2 } from "./types-v2.js";
import { decisionEntry, finiteJson, record } from "./validation-common.js";
import { DecisionContractError } from "./validation.js";

const MAX_JSON_BYTES = 1_048_576;
const MAX_IMAGE_BYTES = 4 * 1_048_576;
const MAX_ENVELOPE_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + MAX_JSON_BYTES + 256;

function fields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function exactKeys(left: object, right: object): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key))
  );
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function probability(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}
function nonnegative(value: unknown): boolean {
  return finite(value) && value >= 0;
}
function confidence(value: unknown): boolean {
  // This is a provider-specific metric, not necessarily a probability.
  return value === undefined || value === null || finite(value);
}
function metadata(value: unknown): boolean {
  return value === undefined || record(value);
}

/** Syntax/canonical encoding only: no file reads, network access, or image decoding. */
function imageSize(dataUri: string): number {
  const prefix = /^data:image\/(?:png|jpeg|webp);base64,/.exec(dataUri);
  if (!prefix) {
    throw new DecisionContractError();
  }
  const encoded = dataUri.slice(prefix[0].length);
  // Avoid a repeated-group regex on a multi-megabyte string (regexp stack limits).
  if (!encoded.length || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) {
    throw new DecisionContractError();
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (encoded.slice(0, encoded.length - padding).includes("=")) {
    throw new DecisionContractError();
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = alphabet.indexOf(encoded.charAt(encoded.length - padding - 1));
  if ((padding === 2 && last % 16 !== 0) || (padding === 1 && last % 4 !== 0)) {
    throw new DecisionContractError();
  }
  return (encoded.length / 4) * 3 - padding;
}

/** Malformed caller data throws; finite supported-shape data over resource bounds returns false. */
export function validateDecisionBatchV2(batch: unknown): batch is DecisionBatchV2 {
  const shape = finiteJson(batch, MAX_ENVELOPE_BYTES, true);
  if (shape === "invalid") {
    throw new DecisionContractError();
  }
  if (shape === "oversized") {
    return false;
  }
  if (
    !record(batch) ||
    !fields(batch, ["state", "questions"]) ||
    !record(batch.state) ||
    !record(batch.questions)
  ) {
    throw new DecisionContractError();
  }
  const state = batch.state;
  let oversized = false;
  if (state.type === "text") {
    if (!fields(state, ["type", "text"]) || typeof state.text !== "string") {
      throw new DecisionContractError();
    }
  } else if (state.type === "json") {
    if (!fields(state, ["type", "value"]) || !Object.hasOwn(state, "value")) {
      throw new DecisionContractError();
    }
  } else if (state.type === "image") {
    if (
      !fields(state, ["type", "dataUri", "text"]) ||
      typeof state.dataUri !== "string" ||
      (state.text !== undefined && typeof state.text !== "string")
    ) {
      throw new DecisionContractError();
    }
    oversized = imageSize(state.dataUri) > MAX_IMAGE_BYTES;
  } else if (state.type === "list") {
    if (!fields(state, ["type", "items"]) || !Array.isArray(state.items)) {
      throw new DecisionContractError();
    }
    const ids = new Set<string>();
    for (const item of state.items) {
      if (
        !record(item) ||
        !fields(item, ["id", "content"]) ||
        typeof item.id !== "string" ||
        !item.id ||
        ids.has(item.id) ||
        !decisionEntry(item.content)
      ) {
        throw new DecisionContractError();
      }
      ids.add(item.id);
    }
    oversized = state.items.length > 120;
  } else {
    throw new DecisionContractError();
  }
  const questions = Object.entries(batch.questions);
  if (!questions.length) {
    throw new DecisionContractError();
  }
  for (const [id, q] of questions) {
    if (
      !id ||
      !record(q) ||
      !fields(
        q,
        q.type === "sort" ? ["type", "instructions"] : ["type", "instructions", "criteria"],
      ) ||
      (q.instructions !== undefined && !decisionEntry(q.instructions))
    ) {
      throw new DecisionContractError();
    }
    if (q.type === "choice" || q.type === "tags") {
      if (
        !record(q.criteria) ||
        Object.keys(q.criteria).length < (q.type === "choice" ? 2 : 1) ||
        !Object.entries(q.criteria).every(
          ([label, entry]) => label.length > 0 && decisionEntry(entry),
        )
      ) {
        throw new DecisionContractError();
      }
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || !q.criteria.every(decisionEntry)) {
        throw new DecisionContractError();
      }
    } else if (q.type === "boolean") {
      if (
        q.criteria !== undefined &&
        q.criteria !== null &&
        (!record(q.criteria) ||
          !Object.entries(q.criteria).every(
            ([key, entry]) => (key === "true" || key === "false") && decisionEntry(entry),
          ))
      ) {
        throw new DecisionContractError();
      }
    } else if (q.type !== "sort" || state.type !== "list") {
      throw new DecisionContractError();
    }
  }
  // Image bytes have a separate ceiling; all remaining evidence shares the V1 JSON budget.
  const jsonEnvelope =
    state.type === "image"
      ? { ...batch, state: { ...state, dataUri: "" } }
      : state.type === "text" || state.type === "json"
        ? { state: state.type === "text" ? state.text : state.value, questions: batch.questions }
        : batch;
  return (
    !oversized &&
    questions.length <= 256 &&
    finiteJson(jsonEnvelope, MAX_JSON_BYTES, true) === "valid"
  );
}

/** A partial provider failure is explicit data, never a negative or fabricated answer. */
export function validateDecisionResultV2(
  batch: DecisionBatchV2,
  value: unknown,
  capabilities?: ModelDecisionCapabilities,
): value is DecisionBatchResultV2 {
  // The supplied batch is normally admitted already; guarding it also makes this pure boundary safe.
  try {
    if (!validateDecisionBatchV2(batch)) {
      return false;
    }
  } catch {
    return false;
  }
  if (
    finiteJson(value, MAX_JSON_BYTES, true) !== "valid" ||
    !record(value) ||
    !fields(value, ["model", "answers", "usage", "metadata"]) ||
    typeof value.model !== "string" ||
    !value.model.length ||
    value.model.length > 256 ||
    !record(value.answers) ||
    !exactKeys(batch.questions, value.answers) ||
    !metadata(value.metadata)
  ) {
    return false;
  }
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (
      !record(usage) ||
      !fields(usage, ["inputTokens", "outputTokens", "costUsd", "units", "raw"]) ||
      [usage.inputTokens, usage.outputTokens, usage.costUsd].some(
        (n) => n !== undefined && !nonnegative(n),
      )
    ) {
      return false;
    }
    if (
      usage.units !== undefined &&
      (!record(usage.units) ||
        !fields(usage.units, ["unit", "amount"]) ||
        (usage.units.unit !== "decision-units" && usage.units.unit !== "requests") ||
        !nonnegative(usage.units.amount))
    ) {
      return false;
    }
  }
  for (const [id, q] of Object.entries(batch.questions)) {
    const answer = value.answers[id];
    if (!record(answer)) {
      return false;
    }
    if (answer.type === "error") {
      if (
        !fields(answer, ["type", "code", "providerCode"]) ||
        typeof answer.code !== "string" ||
        !["unsupported-input", "invalid-input", "provider-error"].includes(answer.code) ||
        (answer.providerCode !== undefined &&
          (typeof answer.providerCode !== "string" || answer.providerCode.length > 128))
      ) {
        return false;
      }
      continue;
    }
    if (answer.type !== q.type || !metadata(answer.metadata)) {
      return false;
    }
    const declared = capabilities?.questions?.[q.type];
    if (capabilities?.questions && !declared) {
      return false;
    }
    if (declared) {
      if (
        !declared.abstention &&
        ((q.type === "boolean" && answer.answer === null) ||
          (q.type === "choice" && answer.choice === null))
      ) {
        return false;
      }
      const estimates =
        q.type === "boolean"
          ? answer.probabilityTrue
          : q.type === "choice" || q.type === "score"
            ? answer.probabilities
            : undefined;
      if (q.type === "boolean" || q.type === "choice" || q.type === "score") {
        if (declared.probabilities === "none" ? estimates !== undefined : estimates === undefined) {
          return false;
        }
        if (
          declared.probabilities === "none" &&
          q.type === "choice" &&
          answer.probability !== undefined
        ) {
          return false;
        }
        if (
          declared.probabilities === "categorical" &&
          estimates &&
          typeof estimates === "object" &&
          !Object.values(estimates).some((estimate) => typeof estimate === "number" && estimate > 0)
        ) {
          return false;
        }
      }
    }
    if (q.type === "boolean") {
      if (
        !fields(answer, ["type", "probabilityTrue", "answer", "metadata"]) ||
        (answer.probabilityTrue === undefined && answer.answer === undefined) ||
        (answer.probabilityTrue !== undefined && !probability(answer.probabilityTrue)) ||
        (answer.answer !== undefined &&
          answer.answer !== null &&
          typeof answer.answer !== "boolean")
      ) {
        return false;
      }
    } else if (q.type === "choice") {
      if (
        !fields(answer, [
          "type",
          "choice",
          "probabilities",
          "probability",
          "confidence",
          "metadata",
        ]) ||
        (answer.choice !== null &&
          (typeof answer.choice !== "string" || !Object.hasOwn(q.criteria, answer.choice))) ||
        (answer.probabilities !== undefined &&
          (!record(answer.probabilities) ||
            !exactKeys(q.criteria, answer.probabilities) ||
            !Object.values(answer.probabilities).every(probability))) ||
        (answer.probability !== undefined &&
          answer.probability !== null &&
          !probability(answer.probability)) ||
        !confidence(answer.confidence)
      ) {
        return false;
      }
    } else if (q.type === "score") {
      if (
        !fields(answer, ["type", "score", "probabilities", "confidence", "metadata"]) ||
        !finite(answer.score) ||
        answer.score < 0 ||
        answer.score > q.criteria.length - 1 ||
        (answer.probabilities !== undefined &&
          (!Array.isArray(answer.probabilities) ||
            answer.probabilities.length !== q.criteria.length ||
            !answer.probabilities.every(probability))) ||
        !confidence(answer.confidence)
      ) {
        return false;
      }
    } else if (q.type === "sort") {
      if (
        !fields(answer, ["type", "order", "confidence", "metadata"]) ||
        batch.state.type !== "list" ||
        !Array.isArray(answer.order) ||
        answer.order.length !== batch.state.items.length ||
        new Set(answer.order).size !== answer.order.length ||
        !answer.order.every(
          (item) =>
            typeof item === "string" &&
            batch.state.type === "list" &&
            batch.state.items.some(({ id: itemId }) => itemId === item),
        ) ||
        !confidence(answer.confidence)
      ) {
        return false;
      }
    } else {
      if (
        !fields(answer, ["type", "tags", "metadata"]) ||
        !Array.isArray(answer.tags) ||
        answer.tags.length !== Object.keys(q.criteria).length
      ) {
        return false;
      }
      const ids = new Set<string>();
      for (const tag of answer.tags) {
        if (
          !record(tag) ||
          !fields(tag, ["id", "probability", "applies"]) ||
          typeof tag.id !== "string" ||
          !Object.hasOwn(q.criteria, tag.id) ||
          ids.has(tag.id) ||
          (tag.probability !== undefined && !probability(tag.probability)) ||
          (declared &&
            (declared.probabilities === "none"
              ? tag.probability !== undefined
              : tag.probability === undefined)) ||
          (declared?.abstention === false && tag.applies === null) ||
          (tag.applies !== null && typeof tag.applies !== "boolean")
        ) {
          return false;
        }
        ids.add(tag.id);
      }
    }
  }
  return true;
}
