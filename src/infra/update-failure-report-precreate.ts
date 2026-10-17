import { sleep } from "../utils/sleep.js";
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

export async function retryUpdateReportStateWrite(
  write: () => boolean | Promise<boolean>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (await write()) {
        return true;
      }
    } catch {
      // Unknown accepted writes must be reconciled, never repeated here.
      return false;
    }
  }
  return false;
}

/** Gives a proven no-transport outcome time to outlive transient SQLite contention. */
export async function retryUpdateReportStateWriteAfterNoStart(
  write: () => boolean | Promise<boolean>,
): Promise<boolean> {
  const retryDelaysMs = [0, 25, 100, 250, 500] as const;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      if (await write()) {
        return true;
      }
    } catch {
      // No transport started, but that alone cannot prove a state write did not commit.
      return false;
    }
  }
  return false;
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
