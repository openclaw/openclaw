import { isDeepStrictEqual } from "node:util";
import { isNativeError, isProxy } from "node:util/types";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";

// The process-global broker can return errors to a different source/built module copy.
const retainedWorkerErrorCode = Symbol.for("openclaw.sqliteWorkerErrorCode");

export class SqliteWorkerError extends Error {
  constructor(
    message: string,
    readonly code: "closed" | "overloaded" | "unavailable" | "outcome-unknown",
  ) {
    super(message);
    this.name = "SqliteWorkerError";
    Object.defineProperty(this, retainedWorkerErrorCode, { value: code });
  }
}

/** Preserve distinct result and settlement failures when adding a worker diagnostic. */
export function wrapSqliteWorkerError(
  message: string,
  code: SqliteWorkerError["code"] | undefined,
  ...causes: unknown[]
): Error {
  const retained = causes
    .filter((cause) => cause !== undefined)
    .map((cause) => toErrorObject(cause, message))
    .filter(
      (cause, index, all) => all.findIndex((other) => isDeepStrictEqual(other, cause)) === index,
    );
  return Object.assign(
    code === undefined ? new Error(message) : new SqliteWorkerError(message, code),
    {
      cause: retained.length > 1 ? new AggregateError(retained, message) : retained[0],
    },
  );
}

/** Carry only canonical worker classification through a local cleanup aggregate. */
export function retainSqliteWorkerErrorCode(error: Error, source: unknown): Error {
  let code: unknown;
  try {
    code = Object.getOwnPropertyDescriptor(source, retainedWorkerErrorCode)?.value;
  } catch {
    // Optional classification must not replace an error that refuses inspection.
    return error;
  }
  if (
    code === "closed" ||
    code === "overloaded" ||
    code === "unavailable" ||
    code === "outcome-unknown"
  ) {
    Object.defineProperty(error, retainedWorkerErrorCode, { value: code });
    Object.assign(error, { code });
  }
  return error;
}

/** Read only this error's retained classification, including cleanup aggregates. */
export function hasSqliteWorkerErrorCode(error: unknown, code: SqliteWorkerError["code"]): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  try {
    return Object.getOwnPropertyDescriptor(error, retainedWorkerErrorCode)?.value === code;
  } catch {
    return false;
  }
}

/** Recognize canonical broker errors without admitting cleanup aggregates for retry. */
export function isSqliteWorkerError(
  error: unknown,
  code: SqliteWorkerError["code"],
): error is SqliteWorkerError {
  return !(error instanceof AggregateError) && hasSqliteWorkerErrorCode(error, code);
}

/** Unknown native outcomes remain terminal through canonical cause and cleanup envelopes. */
export function hasSqliteWorkerOutcomeUnknown(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current) || isProxy(current) || !isNativeError(current)) {
      continue;
    }
    seen.add(current);
    if (
      Object.getOwnPropertyDescriptor(current, retainedWorkerErrorCode)?.value === "outcome-unknown"
    ) {
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
