/** An operator error identified by cron input validation or a domain operation. */
export class CronCliError extends Error {
  readonly originalError?: Error;

  constructor(message: string | Error, options?: ErrorOptions) {
    super(typeof message === "string" ? message : message.message, options);
    // Keep diagnostics from external input readers intact in both output modes.
    this.originalError = typeof message === "string" ? undefined : message;
  }
}
