import { t } from "../../lib/reactive/i18n.ts";

export type SessionHubTab = "sessions" | "projects" | "worktrees";

export function sessionHubTabs(active: SessionHubTab, navigate: (tab: SessionHubTab) => void) {
  return {
    id: "sessions",
    items: [
      { value: "sessions" as const, label: t("tabs.sessions") },
      { value: "projects" as const, label: t("tabs.projects") },
      { value: "worktrees" as const, label: t("tabs.worktrees") },
    ],
    ariaLabel: t("sessionsPage.hubTablistLabel"),
    panelId: "sessions-hub-panel",
    onSelect: (tab: typeof active) => {
      if (tab !== active) {
        navigate(tab);
      }
    },
  };
}
