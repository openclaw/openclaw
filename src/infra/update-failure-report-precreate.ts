export type UpdateReportPreCreateGuardReason = "authority" | "reservation" | "stale" | "validation";

export class UpdateReportPreCreateGuardError extends Error {
  constructor(
    message: string,
    readonly reason: UpdateReportPreCreateGuardReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpdateReportPreCreateGuardError";
  }
}

export function retryUpdateReportStateWrite(write: () => boolean): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (write()) {
        return true;
      }
    } catch {
      // One retry covers a transient state-database failure without replaying transport.
    }
  }
  return false;
}

export async function assertUpdateReportPreCreateState(options: {
  hasCurrentAuthority?: () => boolean;
  validateCurrentAttempt?: () => boolean | Promise<boolean>;
}): Promise<void> {
  if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
    throw new UpdateReportPreCreateGuardError(
      "Update report submission requires a current authenticated client.",
      "authority",
    );
  }
  if (options.validateCurrentAttempt) {
    let currentAttempt: boolean;
    try {
      currentAttempt = await options.validateCurrentAttempt();
    } catch (error) {
      throw new UpdateReportPreCreateGuardError(
        "Update report status could not be rechecked before submission.",
        "validation",
        { cause: error },
      );
    }
    if (!currentAttempt) {
      throw new UpdateReportPreCreateGuardError(
        "This failed update attempt is stale or unavailable.",
        "stale",
      );
    }
  }
  if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
    throw new UpdateReportPreCreateGuardError(
      "Update report submission requires a current authenticated client.",
      "authority",
    );
  }
}
