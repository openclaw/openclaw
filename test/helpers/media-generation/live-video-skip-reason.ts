import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isModelNotFoundErrorMessage,
  isOverloadedErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "openclaw/plugin-sdk/test-env";

export function resolveLiveVideoSkipReason(message: string): string | null {
  if (isAuthErrorMessage(message)) {
    return "auth drift";
  }
  if (isModelNotFoundErrorMessage(message)) {
    return "model drift";
  }
  if (isBillingErrorMessage(message)) {
    return "billing drift";
  }
  if (
    isTimeoutErrorMessage(message) ||
    /did not finish in time/i.test(message) ||
    /last status:\s*in_progress/i.test(message)
  ) {
    return "provider timeout";
  }
  if (isOverloadedErrorMessage(message) || isServerErrorMessage(message)) {
    return "provider outage";
  }
  if (
    /HTTP\s+404/i.test(message) &&
    /Invalid URL/i.test(message) &&
    /\/platform\/video_gen/i.test(message)
  ) {
    return "provider endpoint drift";
  }
  if (/access denied|not authorized|not enabled|permission denied/i.test(message)) {
    return "provider/model drift";
  }
  if (/blocked by (?:our )?moderation system|content policy|policy violation/i.test(message)) {
    return "provider policy drift";
  }
  return null;
}
