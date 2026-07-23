/** Default recent-message page size for `sessions.get`. */
const SESSIONS_GET_DEFAULT_MESSAGE_LIMIT = 200;
/** Hard cap shared with chat.history / sessions-history HTTP transcript pages. */
const SESSIONS_GET_MAX_MESSAGE_LIMIT = 1000;

/** Resolves `sessions.get` limit with a hard upper bound for oversized numeric input. */
export function resolveSessionsGetMessageLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return SESSIONS_GET_DEFAULT_MESSAGE_LIMIT;
  }
  return Math.min(SESSIONS_GET_MAX_MESSAGE_LIMIT, Math.max(1, Math.floor(raw)));
}
