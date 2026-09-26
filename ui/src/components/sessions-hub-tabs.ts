import { t } from "../i18n/index.ts";
import { renderHubTabs } from "./hub-tabs.ts";

export type SessionsHubTab = "sessions" | "worktrees";

type SessionsHubTabsProps = {
  active: SessionsHubTab;
  onSelect: (tab: SessionsHubTab) => void;
};

/** Every route marks its main content with id="sessions-hub-panel". */
export function renderSessionsHubTabs(props: SessionsHubTabsProps) {
  return renderHubTabs<SessionsHubTab>({
    id: "sessions",
    active: props.active,
    tabs: [
      { value: "sessions", label: t("tabs.sessions") },
      { value: "worktrees", label: t("tabs.worktrees") },
    ],
    ariaLabel: t("sessionsPage.hubTablistLabel"),
    panelId: "sessions-hub-panel",
    onSelect: props.onSelect,
  });
}
