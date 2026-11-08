import { readSessionListSelectionFacts } from "../gateway/session-list-target.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { TuiSessionList } from "./tui-backend.js";

export const TUI_RECENT_SESSIONS_ACTIVE_MINUTES = 7 * 24 * 60;
export const TUI_SESSION_PICKER_LIMIT = 50;

/** Exact metadata reads retain the session picker's discovery eligibility. */
export function isListedTuiSession(session: TuiSessionList["sessions"][number]): boolean {
  const { isCronRun, isPhantom } = readSessionListSelectionFacts(session.key, session);
  return !(
    session.archived ||
    session.incognito ||
    isIncognitoSessionKey(session.key) ||
    isCronRun ||
    isPhantom
  );
}
