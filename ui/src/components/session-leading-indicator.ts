import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

export function describeSessionState(session: SidebarRecentSession) {
  return [
    !session.isChild && session.forkSource ? t("sessionsView.forkedSession") : "",
    (session.hasActiveRun ||
      (session.subagentSummary?.runningChildCount ?? session.runningChildCount) > 0 ||
      (session.backgroundProcessCount ?? 0) > 0) &&
    session.unread
      ? t("sessionsView.unread")
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
