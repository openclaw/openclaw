export class CronOperatorSourceError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `The operator authority that created this automation was refused (device, access grant, role or definition changed); recreate it from an authenticated turn. Cause: ${reason}`,
      { cause },
    );
  }
}
