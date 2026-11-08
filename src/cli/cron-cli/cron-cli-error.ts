export type CronCliJobMatch = {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  status: string;
};

/** An operator error identified by cron input validation or a domain operation. */
export class CronCliError extends Error {
  readonly originalError?: Error;
  readonly matches?: readonly CronCliJobMatch[];

  constructor(
    message: string | Error,
    options?: ErrorOptions & { matches?: readonly CronCliJobMatch[] },
  ) {
    super(typeof message === "string" ? message : message.message, options);
    // Keep diagnostics from external input readers intact in both output modes.
    this.originalError = typeof message === "string" ? undefined : message;
    this.matches = options?.matches;
  }
}
