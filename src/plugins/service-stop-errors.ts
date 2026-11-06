export class PluginServiceTimeoutError extends Error {}

export class PluginServiceStopPendingError extends Error {
  constructor(
    message: string,
    readonly settled: Promise<void>,
    cause: unknown,
  ) {
    super(message, { cause });
    // The original stop remains owned even when no recovery observer is admitted.
    void settled.catch(() => {});
  }
}

/** Observe only an issued service stop; mixed or permanent failures remain barriers. */
export function getPluginServiceCleanupSettlement(
  error: unknown,
): { error: AggregateError; settled: Promise<void> } | undefined {
  if (
    !(error instanceof AggregateError) ||
    error.errors.length === 0 ||
    !error.errors.every((failure) => failure instanceof PluginServiceStopPendingError)
  ) {
    return undefined;
  }
  const settled = Promise.all(
    error.errors.map((failure: PluginServiceStopPendingError) => failure.settled),
  ).then(() => {});
  void settled.catch(() => {});
  return { error, settled };
}
