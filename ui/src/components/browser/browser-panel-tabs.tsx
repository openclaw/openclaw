import { createMemo } from "@solidjs/signals";
import { t } from "../../lib/reactive/i18n.ts";
import type { TabFocus } from "../../lib/tabs.ts";
import { PanelTabStrip } from "../panel-tab-strip-solid.tsx";
import type { BrowserPanelTab } from "./browser-client.ts";
import { browserPanelHostedTabs } from "./browser-panel-tabs.ts";

export function BrowserPanelTabs(props: {
  panelId: string;
  focusOwner: TabFocus;
  tabs: BrowserPanelTab[];
  activeTargetId: string | null;
  onSelect: (targetId: string) => void;
  onClose: (targetId: string) => void | Promise<void>;
  onNew: () => void;
  hideNewControl?: boolean;
}) {
  const sourceTabs = createMemo(() => props.tabs);
  const tabs = createMemo(() =>
    browserPanelHostedTabs(sourceTabs(), document).map((tab, index) => ({
      id: tab.id,
      domId: `${props.panelId}-tab-${tab.id}`,
      label: tab.label,
      title: `${t(sourceTabs()[index]?.kind === "native" ? "browser.nativeTab" : "browser.remoteTab")}: ${tab.url}`,
      icon: tab.favicon ? <img class="tabstrip-tab__favicon" src={tab.favicon} alt="" /> : tab.icon,
      closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
    })),
  );
  return (
    <PanelTabStrip
      focusOwner={props.focusOwner}
      tabs={tabs()}
      activeId={props.activeTargetId}
      ariaControls={props.panelId}
      onSelect={props.onSelect}
      onClose={props.onClose}
      onNew={props.onNew}
      newLabel={t("browser.newTab")}
      newTabAction
      newControl={props.hideNewControl ? null : undefined}
    />
  );
}
