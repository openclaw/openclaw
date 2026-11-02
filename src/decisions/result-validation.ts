import type {
  DecisionAnswerCapabilities,
  ModelDecisionCapabilities,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { validateDecisionBatchV2 } from "./input-validation.js";
import type { DecisionBatchResultV2, DecisionBatchV2 } from "./types-v2.js";
import {
  exactKeys,
  finiteJson,
  hasOnlyDecisionFields,
  isPlainDecisionRecord,
} from "./validation-common.js";

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
  return value === undefined || isPlainDecisionRecord(value);
}

/** A partial provider failure is explicit data, never a negative or fabricated answer. */
export function validateDecisionResultV2(
  batch: DecisionBatchV2,
  value: unknown,
  capabilities?: DecisionAnswerCapabilities | ModelDecisionCapabilities,
): value is DecisionBatchResultV2 {
  // The supplied batch is normally admitted already; guarding it also makes this pure boundary safe.
  try {
    if (!validateDecisionBatchV2(batch)) {
      return false;
    }
  } catch {
    return false;
  }
  return validateAdmittedDecisionResultV2(batch, value, capabilities);
}

/** Internal result boundary for a host-owned, admitted snapshot kept outside provider reach. */
export function validateAdmittedDecisionResultV2(
  batch: DecisionBatchV2,
  value: unknown,
  capabilities?: DecisionAnswerCapabilities,
): value is DecisionBatchResultV2 {
  if (
    finiteJson(value, { rejectProxies: true }) !== "valid" ||
    !isPlainDecisionRecord(value) ||
    !hasOnlyDecisionFields(value, ["model", "answers", "usage", "metadata"]) ||
    typeof value.model !== "string" ||
    !value.model.length ||
    value.model.length > 256 ||
    !isPlainDecisionRecord(value.answers) ||
    !exactKeys(batch.questions, value.answers) ||
    !metadata(value.metadata)
  ) {
    return false;
  }
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (
      !isPlainDecisionRecord(usage) ||
      !hasOnlyDecisionFields(usage, ["inputTokens", "outputTokens", "costUsd", "units", "raw"]) ||
      [usage.inputTokens, usage.outputTokens, usage.costUsd].some(
        (n) => n !== undefined && !nonnegative(n),
      )
    ) {
      return false;
    }
    if (
      usage.units !== undefined &&
      (!isPlainDecisionRecord(usage.units) ||
        !hasOnlyDecisionFields(usage.units, ["unit", "amount"]) ||
        (usage.units.unit !== "decision-units" && usage.units.unit !== "requests") ||
        !nonnegative(usage.units.amount))
    ) {
      return false;
    }
  }
  for (const [id, q] of Object.entries(batch.questions)) {
    const answer = value.answers[id];
    if (!isPlainDecisionRecord(answer)) {
      return false;
    }
    if (answer.type === "error") {
      if (
        !hasOnlyDecisionFields(answer, ["type", "code", "providerCode"]) ||
        typeof answer.code !== "string" ||
        !["unsupported-input", "invalid-input", "provider-error"].includes(answer.code) ||
        (answer.providerCode !== undefined &&
          (typeof answer.providerCode !== "string" || answer.providerCode.length > 128))
      ) {
        return false;
      }
      continue;
    }
    if (
      answer.type !== q.type ||
      !metadata(answer.metadata) ||
      (capabilities?.confidence === "none" && answer.confidence !== undefined)
    ) {
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
        !hasOnlyDecisionFields(answer, ["type", "probabilityTrue", "answer", "metadata"]) ||
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
        !hasOnlyDecisionFields(answer, [
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
          (!isPlainDecisionRecord(answer.probabilities) ||
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
        !hasOnlyDecisionFields(answer, [
          "type",
          "score",
          "probabilities",
          "confidence",
          "metadata",
        ]) ||
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
    } else if (q.type === "box") {
      const box = answer.box;
      if (
        !hasOnlyDecisionFields(answer, ["type", "box", "confidence", "metadata"]) ||
        !isPlainDecisionRecord(box) ||
        !exactKeys(box, { top: 0, bottom: 0, left: 0, right: 0 }) ||
        !probability(box.top) ||
        !probability(box.bottom) ||
        !probability(box.left) ||
        !probability(box.right) ||
        box.top >= box.bottom ||
        box.left >= box.right ||
        !confidence(answer.confidence)
      ) {
        return false;
      }
    } else if (q.type === "sort") {
      if (
        !hasOnlyDecisionFields(answer, ["type", "order", "confidence", "metadata"]) ||
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
        !hasOnlyDecisionFields(answer, ["type", "tags", "metadata"]) ||
        !Array.isArray(answer.tags) ||
        answer.tags.length !== Object.keys(q.criteria).length
      ) {
        return false;
      }
      const ids = new Set<string>();
      for (const tag of answer.tags) {
        if (
          !isPlainDecisionRecord(tag) ||
          !hasOnlyDecisionFields(tag, ["id", "probability", "applies"]) ||
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
