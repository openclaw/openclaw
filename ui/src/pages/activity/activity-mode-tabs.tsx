import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export function ActivityModeTabs(props: { mode: string; onSelect: (mode: string) => void }) {
  return (
    <HubTabs
      id="activity-mode"
      active={props.mode}
      tabs={[
        { value: "sessions", label: t("activityFeed.sessionsMode") },
        { value: "live", label: t("activity.runInspector.liveMode") },
      ]}
      ariaLabel={t("activity.runInspector.activityView")}
      panelId="activity-mode-panel"
      class="activity-mode-tabs"
      variant="sub"
      onSelect={props.onSelect}
    />
  );
}
