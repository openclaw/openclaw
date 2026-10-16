/** Stable code that survives channel and framework error wrappers. */
export const SESSION_WORK_START_INVALIDATED_ERROR_CODE = "SESSION_WORK_START_INVALIDATED";
export const SESSION_WORK_START_CHANGED_ERROR_CODE = "SESSION_WORK_START_CHANGED";
export const SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE = "SESSION_RESTART_RECOVERY_TOMBSTONE";

export class SessionWorkStartInvalidatedError extends Error {
  readonly code = SESSION_WORK_START_INVALIDATED_ERROR_CODE;

  override name = "SessionWorkStartInvalidatedError";
}

export class SessionWorkStartChangedError extends Error {
  readonly code = SESSION_WORK_START_CHANGED_ERROR_CODE;

  override name = "SessionWorkStartChangedError";
}

export function createSessionWorkStartChangedError(
  sessionKey: string,
): SessionWorkStartChangedError {
  return new SessionWorkStartChangedError(
    `Session "${sessionKey}" changed while starting work. Retry.`,
  );
}

export function isSessionWorkStartInvalidatedError(
  error: unknown,
): error is SessionWorkStartInvalidatedError | SessionWorkStartChangedError {
  return (
    error instanceof SessionWorkStartInvalidatedError ||
    error instanceof SessionWorkStartChangedError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === SESSION_WORK_START_INVALIDATED_ERROR_CODE ||
        error.code === SESSION_WORK_START_CHANGED_ERROR_CODE))
  );
}

export class SessionRestartRecoveryTombstoneError extends Error {
  readonly code = SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE;

  override name = "SessionRestartRecoveryTombstoneError";
}
