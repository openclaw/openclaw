// Deep equality on an explicit work stack: the platform `isDeepStrictEqual`
// compares nested containers on the call stack, so a schema-valid deep config
// overflows before the comparison returns. Containers are walked iteratively;
// leaves keep the platform comparison semantics.
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";

export function deepEqualStackSafe(a: unknown, b: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[a, b]];
  while (pending.length > 0) {
    const pair = pending.pop();
    if (pair === undefined) {
      break;
    }
    const [left, right] = pair;
    if (Object.is(left, right)) {
      continue;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) {
        return false;
      }
      for (let index = left.length - 1; index >= 0; index -= 1) {
        pending.push([left[index], right[index]]);
      }
      continue;
    }
    if (isRecord(left) && isRecord(right)) {
      const leftKeys = Object.keys(left);
      if (leftKeys.length !== Object.keys(right).length) {
        return false;
      }
      for (const key of leftKeys) {
        if (!Object.hasOwn(right, key)) {
          return false;
        }
        pending.push([left[key], right[key]]);
      }
      continue;
    }
    if (!isDeepStrictEqual(left, right)) {
      return false;
    }
  }
  return true;
}
