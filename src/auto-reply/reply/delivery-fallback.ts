import { resolveFailoverReasonFromError } from "../../agents/failover-error.js";

/** Error thrown when the model returned an empty response */
export class EmptyResponseError extends Error {
  constructor(message = "No response generated") {
    super(message);
    this.name = "EmptyResponseError";
  }
}

/** Maps a FailoverReason to a user-facing fallback message */
const FALLBACK_MESSAGES: Record<string, string> = {
  rate_limit: "You're sending messages too quickly. Please wait a moment and try again.",
  overloaded: "The service is experiencing high demand. Please try again in a few moments.",
  timeout: "The request took too long. Please try again.",
  billing: "There's an account issue. Please try again later.",
  auth: "Authentication failed. Please try again later.",
  auth_permanent: "Authentication failed. Please try again later.",
  session_expired: "Your session has expired. Please start a new conversation.",
  model_not_found: "The AI model is unavailable. Please try again.",
  format: "Sorry, I encountered an error processing your message.",
  unknown: "Something went wrong while processing your request. Please try again.",
};

/** Default message when dispatch itself throws before delivery can be attempted */
export const DISPATCH_ERROR_FALLBACK = "Something went wrong while processing your request. Please try again.";

/** Message shown when no response was generated at all */
export const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/**
 * Returns a user-facing fallback message appropriate for the given error.
 *
 * Uses resolveFailoverReasonFromError to classify the error type, then
 * selects a user-friendly message that explains the issue without leaking
 * internal details.
 */
export function resolveFallbackMessage(err: unknown): string {
  const reason = resolveFailoverReasonFromError(err);
  if (reason && FALLBACK_MESSAGES[reason]) {
    return FALLBACK_MESSAGES[reason]!;
  }
  return DISPATCH_ERROR_FALLBACK;
}

/**
 * Returns true if the error appears to be an empty / no-content response.
 */
export function isEmptyResponseError(err: unknown): boolean {
  return err instanceof EmptyResponseError;
}
