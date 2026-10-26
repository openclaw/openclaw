export {
  collectNestedErrorCandidates,
  extractErrorCodeOrErrno,
} from "@openclaw/normalization-core/error-coercion";

/** Await owned work and cleanup, retaining both failures without changing their identity. */
export async function settleWithCleanup<T>(
  operation: Promise<T>,
  cleanup: () => void | Promise<void>,
  message: string,
): Promise<T> {
  const [outcome] = await Promise.allSettled([operation]);
  try {
    await cleanup();
  } catch (error) {
    if (outcome.status === "rejected") {
      throw new AggregateError([outcome.reason, error], message, { cause: error });
    }
    throw error;
  }
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

export function throwIfSettledRejected(
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
): void {
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  throwCollectedErrors(failures, message);
}

/** Keep an aggregate envelope even when only one joined operation failed. */
export function throwSettledAggregate(
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
): void {
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, message);
  }
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

/** Run every operation in iteration order; callers retain their own settlement and error envelope. */
export function collectSynchronousErrors<T>(
  items: Iterable<T>,
  run: (item: T) => unknown,
): unknown[] {
  const errors: unknown[] = [];
  for (const item of items) {
    try {
      run(item);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
