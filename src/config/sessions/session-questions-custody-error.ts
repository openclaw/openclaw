import { isNativeError, isProxy } from "node:util/types";
/** A captured question can never acquire a successor database or session incarnation. */
export class SessionQuestionCustodyRetiredError extends Error {
  override name = "SessionQuestionCustodyRetiredError";
  readonly code = "question-custody-retired";
}

export function hasSessionQuestionCustodyRetiredError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current) || isProxy(current) || !isNativeError(current)) {
      continue;
    }
    seen.add(current);
    if (Object.getOwnPropertyDescriptor(current, "code")?.value === "question-custody-retired") {
      return true;
    }
    const cause = Object.getOwnPropertyDescriptor(current, "cause");
    if (cause && "value" in cause) {
      pending.push(cause.value);
    }
    let prototype = Object.getPrototypeOf(current);
    let aggregate = false;
    while (prototype && !isProxy(prototype)) {
      const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      if (
        prototype === AggregateError.prototype ||
        (typeof constructor === "function" &&
          !isProxy(constructor) &&
          Object.getOwnPropertyDescriptor(constructor, "name")?.value === "AggregateError" &&
          Object.getOwnPropertyDescriptor(constructor, "prototype")?.value === prototype &&
          Object.getOwnPropertyDescriptor(prototype, "name")?.value === "AggregateError")
      ) {
        aggregate = true;
        break;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!aggregate) {
      continue;
    }
    const errors: unknown = Object.getOwnPropertyDescriptor(current, "errors")?.value;
    if (isProxy(errors) || !Array.isArray(errors)) {
      continue;
    }
    // Read data slots, never an error object's getters or a supplied array iterator.
    for (const key of Object.keys(errors)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) {
        continue;
      }
      const item = Object.getOwnPropertyDescriptor(errors, key);
      if (item && "value" in item) {
        pending.push(item.value);
      }
    }
  }
  return false;
}
