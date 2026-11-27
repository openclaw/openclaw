export class CronOperatorSourceError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `The operator authority that created this automation was refused (device, access grant, role or definition changed); recreate it from an authenticated turn. Cause: ${reason}`,
      { cause },
    );
  }
}

/** A refused operator source ends the job's runs for good; any other error keeps propagating. */
export function cronOperatorSourceRefusal(error: unknown) {
  if (!(error instanceof CronOperatorSourceError)) {
    throw error;
  }
  return {
    status: "error" as const,
    error: error.message,
    errorClassification: { kind: "permanent" as const },
    executionStarted: false,
  };
}
