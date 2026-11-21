export class CronOperatorSourceError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `The access of the person who created it was refused because their device, access grant or role changed. Cause: ${reason}`,
      { cause },
    );
  }
}
