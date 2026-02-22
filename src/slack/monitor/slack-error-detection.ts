/**
 * Slack API errors that @slack/socket-mode treats as unrecoverable during reconnection.
 * When these occur during an internal reconnect attempt, the socket-mode client throws
 * an error that escapes the promise chain and becomes an unhandled rejection.
 * See: @slack/socket-mode/src/UnrecoverableSocketModeStartError.ts
 */
const SLACK_UNRECOVERABLE_AUTH_ERRORS = new Set([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "user_removed_from_team",
  "team_disabled",
]);

/**
 * Detects Slack Web API platform errors (code: "slack_webapi_platform_error").
 * These are thrown by @slack/web-api when the Slack API returns an error response,
 * and may escape as unhandled rejections during socket-mode reconnection.
 */
export function isSlackPlatformError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  return (err as { code?: string }).code === "slack_webapi_platform_error";
}

/**
 * Checks if a Slack platform error is an auth/account error that the socket-mode
 * client considers unrecoverable (and therefore throws instead of retrying).
 */
export function isSlackUnrecoverableAuthError(err: unknown): boolean {
  if (!isSlackPlatformError(err)) {
    return false;
  }
  const dataError = (err as { data?: { error?: string } }).data?.error;
  return dataError !== undefined && SLACK_UNRECOVERABLE_AUTH_ERRORS.has(dataError);
}

/**
 * Extracts the Slack API error string from a platform error, if present.
 */
export function getSlackErrorCode(err: unknown): string | undefined {
  if (!isSlackPlatformError(err)) {
    return undefined;
  }
  return (err as { data?: { error?: string } }).data?.error;
}
