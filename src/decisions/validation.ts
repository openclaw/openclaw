import type { DecisionBatch, DecisionBatchResult } from "./types.js";

const MAX_BYTES = 1_048_576;
const MAX_NODES = 20_000;

/** A caller contract defect is not a provider outage. Never include evidence in errors. */
export class DecisionContractError extends Error {
  constructor() {
    super("Invalid decision contract; check the version 1 input and evaluation options.");
    this.name = "DecisionContractError";
  }
}

/** The finite consumer view was released or replaced while a decision was in flight. */
export class DecisionConsumerClosedError extends Error {
  constructor() {
    super("Decision consumer authority closed.");
    this.name = "DecisionConsumerClosedError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function finiteJsonUnchecked(value: unknown): "valid" | "oversized" | "invalid" {
  let nodes = 0;
  let bytes = 0;
  let tooDeep = false;
  const ancestors = new Set<object>();
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 32) {
      tooDeep = true;
      return true;
    }
    if (++nodes > MAX_NODES) {
      return true;
    }
    if (entry === null || typeof entry === "boolean") {
      return true;
    }
    if (typeof entry === "number") {
      return Number.isFinite(entry);
    }
    if (typeof entry === "string") {
      bytes += Buffer.byteLength(entry);
      return true;
    }
    if (typeof entry !== "object" || !entry || ancestors.has(entry)) {
      return false;
    }
    const array = Array.isArray(entry);
    if (array ? Object.getPrototypeOf(entry) !== Array.prototype : !record(entry)) {
      return false;
    }
    const keys = Reflect.ownKeys(entry);
    if (keys.length > MAX_NODES || (array && entry.length > MAX_NODES)) {
      nodes = MAX_NODES + 1;
      return true;
    }
    if (keys.some((key) => typeof key !== "string")) {
      return false;
    }
    if (array && keys.length !== entry.length + 1) {
      return false;
    }
    if (array) {
      for (let index = 0; index < entry.length; index++) {
        if (!Object.hasOwn(entry, index)) {
          return false;
        }
      }
    }
    ancestors.add(entry);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
      if (array && key === "length") {
        continue;
      }
      // Hidden data would disappear from the admitted structured clone.
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return false;
      }
      const item: unknown = descriptor.value;
      bytes += Buffer.byteLength(key);
      if (!visit(item, depth + 1)) {
        return false;
      }
      if (nodes > MAX_NODES || bytes > MAX_BYTES) {
        break;
      }
    }
    ancestors.delete(entry);
    return true;
  };
  if (!visit(value, 0)) {
    return "invalid";
  }
  if (tooDeep || nodes > MAX_NODES || bytes > MAX_BYTES) {
    return "oversized";
  }
  // Bound encoded escaping/structure as well as string payloads.
  return Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES ? "oversized" : "valid";
}

function finiteJson(value: unknown): "valid" | "oversized" | "invalid" {
  try {
    return finiteJsonUnchecked(value);
  } catch {
    return "invalid";
  }
}

function decisionEntry(value: unknown): boolean {
  return value === null || typeof value === "string" || Array.isArray(value) || record(value);
}

/** Returns false only for locally unsupported resource size, never silently truncates. */
export function validateDecisionBatch(batch: unknown): batch is DecisionBatch {
  const shape = finiteJson(batch);
  if (shape === "invalid") {
    throw new DecisionContractError();
  }
  if (shape === "oversized") {
    return false;
  }
  if (!record(batch) || !decisionEntry(batch.state) || !record(batch.questions)) {
    throw new DecisionContractError();
  }
  const questions = Object.entries(batch.questions);
  if (!questions.length) {
    throw new DecisionContractError();
  }
  if (questions.length > 256) {
    return false;
  }
  for (const [id, q] of questions) {
    if (!id || !record(q) || (q.instructions !== undefined && !decisionEntry(q.instructions))) {
      throw new DecisionContractError();
    }
    if (q.type === "choice") {
      if (
        !record(q.criteria) ||
        Object.keys(q.criteria).length < 2 ||
        !Object.entries(q.criteria).every(
          ([label, description]) => label.length > 0 && decisionEntry(description),
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
            ([key, value]) => (key === "true" || key === "false") && decisionEntry(value),
          ))
      ) {
        throw new DecisionContractError();
      }
    } else {
      throw new DecisionContractError();
    }
  }
  return true;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function distribution(values: unknown[]): values is number[] {
  return values.every(probability) && values.some((value) => value > 0);
}
function exactKeys(left: object, right: object): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key))
  );
}

/** Validate all answers before returning any; provider data never grants partial acceptance. */
export function validateDecisionResult(
  batch: Pick<DecisionBatch, "questions">,
  value: unknown,
): value is DecisionBatchResult {
  if (
    finiteJson(value) !== "valid" ||
    !record(value) ||
    typeof value.model !== "string" ||
    !value.model.length ||
    value.model.length > 256 ||
    !record(value.answers) ||
    !exactKeys(batch.questions, value.answers)
  ) {
    return false;
  }
  if (
    value.usage !== undefined &&
    (!record(value.usage) ||
      !Object.entries(value.usage).every(
        ([key, n]) =>
          (key === "inputTokens" || key === "outputTokens") &&
          typeof n === "number" &&
          Number.isFinite(n) &&
          n >= 0,
      ))
  ) {
    return false;
  }
  for (const [id, question] of Object.entries(batch.questions)) {
    const answer = value.answers[id];
    if (!record(answer) || answer.type !== question.type) {
      return false;
    }
    if (
      answer.confidence !== undefined &&
      (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence))
    ) {
      return false;
    }
    if (question.type === "boolean") {
      if (!probability(answer.probabilityTrue)) {
        return false;
      }
    } else if (question.type === "choice") {
      if (
        typeof answer.choice !== "string" ||
        !Object.hasOwn(question.criteria, answer.choice) ||
        !record(answer.probabilities) ||
        !exactKeys(question.criteria, answer.probabilities)
      ) {
        return false;
      }
      const values = Object.values(answer.probabilities);
      if (!distribution(values)) {
        return false;
      }
    } else {
      if (
        !Array.isArray(answer.probabilities) ||
        answer.probabilities.length !== question.criteria.length ||
        !distribution(answer.probabilities) ||
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1
      ) {
        return false;
      }
    }
  }
  return true;
}
