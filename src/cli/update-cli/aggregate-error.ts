// Aggregate error construction shared by update-cli paths that must preserve a cause.
export function createAggregateErrorWithCause(
  errors: unknown[],
  message: string,
  cause: unknown,
): AggregateError {
  return new AggregateError(errors, message, { cause });
}
