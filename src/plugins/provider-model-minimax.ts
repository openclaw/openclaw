import { matchesExactOrPrefix } from "./provider-model-helpers.js";

export const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.7";
export const MINIMAX_DEFAULT_MODEL_REF = `minimax/${MINIMAX_DEFAULT_MODEL_ID}`;

export const MINIMAX_TEXT_MODEL_ORDER = [
  "MiniMax-M2",
  "MiniMax-M2.1",
  "MiniMax-M2.1-highspeed",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
] as const;

export const MINIMAX_TEXT_MODEL_CATALOG = {
  "MiniMax-M2": { name: "MiniMax M2", reasoning: true },
  "MiniMax-M2.1": { name: "MiniMax M2.1", reasoning: true },
  "MiniMax-M2.1-highspeed": { name: "MiniMax M2.1 Highspeed", reasoning: true },
  "MiniMax-M2.7": { name: "MiniMax M2.7", reasoning: true },
  "MiniMax-M2.7-highspeed": { name: "MiniMax M2.7 Highspeed", reasoning: true },
  "MiniMax-M2.5": { name: "MiniMax M2.5", reasoning: true },
  "MiniMax-M2.5-highspeed": { name: "MiniMax M2.5 Highspeed", reasoning: true },
} as const;

export const MINIMAX_TEXT_MODEL_REFS = MINIMAX_TEXT_MODEL_ORDER.map(
  (modelId) => `minimax/${modelId}`,
);

export const MINIMAX_MODERN_MODEL_MATCHERS = [
  "minimax-m2",
  "minimax-m2.1",
  "minimax-m2.5",
  "minimax-m2.7",
] as const;

export function isMiniMaxModernModelId(modelId: string): boolean {
  return matchesExactOrPrefix(modelId, MINIMAX_MODERN_MODEL_MATCHERS);
}
