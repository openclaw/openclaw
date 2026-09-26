import { stableStringify } from "@openclaw/normalization-core";
import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";

// The execution wrapper records the raw result before presentation or serialization.
// Keep semantic card state private: revisions must still acknowledge unchanged refreshes.
const outcomes = new WeakMap<object, string>();

export function recordProgressCardToolOutcome<T extends object>(
  result: T,
  card: ProgressCard | null,
): T {
  outcomes.set(
    result,
    stableStringify({ markdown: card?.markdown ?? null, steps: card?.steps ?? null }),
  );
  return result;
}

export function getProgressCardToolOutcome(result: object): string | undefined {
  return outcomes.get(result);
}
