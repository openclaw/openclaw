export {
  collectNestedErrorCandidates,
  extractErrorCodeOrErrno,
} from "@openclaw/normalization-core/error-coercion";

export function throwIfSettledRejected(
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
): void {
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  throwCollectedErrors(failures, message);
}

/** Preserve a sole failure; aggregate independent failures in their original order. */
export function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, message);
  }
}

/** Retained errors must not keep callers alive through V8's lazy stack frames. */
export function materializeErrorStack(failure: unknown): void {
  let error = failure;
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    try {
      error.stack = String(error.stack);
    } catch {
      // The setter releases private frames even when a custom formatter throws.
      error.stack = "Stack trace unavailable: custom formatter failed";
    }
    error = error.cause;
  }
}
