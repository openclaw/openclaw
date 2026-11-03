import { t } from "../../lib/reactive/i18n.ts";

export function sessionHubTabs(
  active: "sessions" | "worktrees",
  navigate: (tab: "sessions" | "worktrees") => void,
) {
  return {
    id: "sessions",
    items: [
      { value: "sessions" as const, label: t("tabs.sessions") },
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
