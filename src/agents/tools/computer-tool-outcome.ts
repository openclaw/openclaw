import { stableStringify } from "@openclaw/normalization-core";
import type { ComputerActResult } from "../../plugins/computer-use-contract.js";

// Keep comparison identities private; the model still needs each fresh reference.
const outcomes = new WeakMap<object, string>();

export function recordComputerToolOutcome<T extends object>(
  result: T,
  observed: ComputerActResult,
): T {
  const observation = observed.observation;
  if (observation?.kind !== "window") {
    return result;
  }
  const { observationId: _observationId, elements, ...state } = observation;
  outcomes.set(
    result,
    stableStringify({
      ...observed,
      observation: {
        ...state,
        elements: elements?.map(({ elementRef: _elementRef, ...element }) => element),
      },
    }),
  );
  return result;
}

export function getComputerToolOutcome(result: object): string | undefined {
  return outcomes.get(result);
}
