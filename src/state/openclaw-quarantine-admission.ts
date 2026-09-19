import {
  createOpenClawDatabaseVerificationError,
  OpenClawQuarantineReadCleanupError,
  readOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";

/** Reject a known quarantine while retaining best-effort metadata admission. */
export function assertOpenClawDatabaseNotQuarantined(
  kind: "agent" | "state",
  pathname: string,
  env: NodeJS.ProcessEnv,
  onNativeCleanupFailure?: (error: OpenClawQuarantineReadCleanupError) => void,
): void {
  let quarantine: ReturnType<typeof readOpenClawDatabaseQuarantine>;
  let cleanupFailure: OpenClawQuarantineReadCleanupError | undefined;
  try {
    quarantine = readOpenClawDatabaseQuarantine(pathname, { env });
  } catch (error) {
    // Unreadable metadata remains best effort; failed cleanup cannot erase a validated decision.
    if (error instanceof OpenClawQuarantineReadCleanupError) {
      quarantine = error.quarantine;
      cleanupFailure = error;
      onNativeCleanupFailure?.(error);
    }
  }
  if (quarantine) {
    const failure = createOpenClawDatabaseVerificationError(kind, pathname, quarantine.reason);
    if (cleanupFailure) {
      failure.cause = cleanupFailure;
    }
    throw failure;
  }
}
