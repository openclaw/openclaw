import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence-error.js";
import { GatewayDrainingError } from "./gateway-work-admission.js";

export function isExpectedRunCancellation(error: unknown): boolean {
  if (error instanceof GatewayDrainingError || error instanceof SessionTranscriptReadFenceError) {
    return true;
  }
  if (error instanceof AggregateError) {
    // Cancellation must not hide an independent cleanup failure.
    return (
      error.errors.length > 0 &&
      error.errors.every(isExpectedRunCancellation) &&
      (error.cause === undefined || isExpectedRunCancellation(error.cause))
    );
  }
  return (
    error instanceof Error && error.cause !== undefined && isExpectedRunCancellation(error.cause)
  );
}
