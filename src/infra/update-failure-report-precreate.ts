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

export async function tryUpdateReportStateWrite(
  write: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return await write();
  } catch {
    // Unknown accepted writes must be reconciled, never repeated here.
    return false;
  }
}

export function assertUpdateReportSubmissionAuthority(options: {
  hasCurrentAuthority?: () => boolean;
}): void {
  if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
    throw new UpdateReportPreCreateGuardError(
      "Update report submission requires a current authenticated client.",
      "authority",
    );
  }
}

export async function assertUpdateReportPreCreateState(options: {
  hasCurrentAuthority?: () => boolean;
  validateCurrentAttempt?: () => boolean | Promise<boolean>;
}): Promise<void> {
  assertUpdateReportSubmissionAuthority(options);
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
  assertUpdateReportSubmissionAuthority(options);
}
