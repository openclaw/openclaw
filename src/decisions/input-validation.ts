import { DecisionContractError } from "./contract-error.js";
import type { DecisionBatchV2 } from "./types-v2.js";
import {
  decisionEntry,
  decisionJsonLimits,
  finiteJson,
  hasOnlyDecisionFields,
  isPlainDecisionRecord,
  validDecisionCriteria,
} from "./validation-common.js";

const MAX_JSON_BYTES = decisionJsonLimits.maxBytes;
const MAX_IMAGE_BYTES = 4 * 1_048_576;
const MAX_ENVELOPE_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + MAX_JSON_BYTES + 256;

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
  // Text/JSON framing adds one level and two nodes. The unwrapped evidence
  // below still uses the original limits, so admitted V1 batches stay convertible.
  const shape = finiteJson(batch, {
    maxBytes: MAX_ENVELOPE_BYTES,
    maxDepth: decisionJsonLimits.maxDepth + 1,
    maxNodes: decisionJsonLimits.maxNodes + 2,
    rejectProxies: true,
  });
  if (shape === "invalid") {
    throw new DecisionContractError();
  }
  if (shape === "oversized") {
    return false;
  }
  if (
    !isPlainDecisionRecord(batch) ||
    !hasOnlyDecisionFields(batch, ["state", "questions"]) ||
    !isPlainDecisionRecord(batch.state) ||
    !isPlainDecisionRecord(batch.questions)
  ) {
    throw new DecisionContractError();
  }
  const state = batch.state;
  let oversized = false;
  if (state.type === "text") {
    if (!hasOnlyDecisionFields(state, ["type", "text"]) || typeof state.text !== "string") {
      throw new DecisionContractError();
    }
  } else if (state.type === "json") {
    if (!hasOnlyDecisionFields(state, ["type", "value"]) || !Object.hasOwn(state, "value")) {
      throw new DecisionContractError();
    }
  } else if (state.type === "image") {
    if (
      !hasOnlyDecisionFields(state, ["type", "dataUri", "text"]) ||
      typeof state.dataUri !== "string" ||
      (state.text !== undefined && typeof state.text !== "string")
    ) {
      throw new DecisionContractError();
    }
    oversized = imageSize(state.dataUri) > MAX_IMAGE_BYTES;
  } else if (state.type === "list") {
    if (!hasOnlyDecisionFields(state, ["type", "items"]) || !Array.isArray(state.items)) {
      throw new DecisionContractError();
    }
    const ids = new Set<string>();
    for (const item of state.items) {
      if (
        !isPlainDecisionRecord(item) ||
        !hasOnlyDecisionFields(item, ["id", "content"]) ||
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
      !isPlainDecisionRecord(q) ||
      !hasOnlyDecisionFields(
        q,
        q.type === "sort" || q.type === "box"
          ? ["type", "instructions"]
          : ["type", "instructions", "criteria"],
      ) ||
      (q.instructions !== undefined && !decisionEntry(q.instructions))
    ) {
      throw new DecisionContractError();
    }
    if (q.type === "box") {
      if (state.type !== "image" || q.instructions == null) {
        throw new DecisionContractError();
      }
    } else if (q.type === "sort") {
      if (state.type !== "list") {
        throw new DecisionContractError();
      }
    } else if (!validDecisionCriteria(q.type, q.criteria)) {
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
    questions.length <= 400 &&
    finiteJson(jsonEnvelope, { rejectProxies: true }) === "valid"
  );
}
