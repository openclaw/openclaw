import { createMemo } from "@solidjs/signals";
import { t } from "../../lib/reactive/i18n.ts";
import { PanelTabStrip } from "../panel-tab-strip-solid.tsx";
import { Icon } from "../solid/icon.tsx";
import type { BrowserPanelTab } from "./browser-client.ts";
import { browserPanelHostedTabs } from "./browser-panel-tabs.ts";

export function BrowserPanelTabs(props: {
  panelId: string;
  tabs: BrowserPanelTab[];
  activeTargetId: string | null;
  onSelect: (targetId: string) => void;
  onClose: (targetId: string) => void | Promise<void>;
  onNew: () => void;
  hideNewControl?: boolean;
}) {
  const sourceTabs = createMemo(() => props.tabs);
  const tabs = createMemo(() =>
    browserPanelHostedTabs(sourceTabs()).map((tab, index) => ({
      id: tab.id,
      domId: `${props.panelId}-tab-${tab.id}`,
      label: tab.label,
      title: `${t(sourceTabs()[index]?.kind === "native" ? "browser.nativeTab" : "browser.remoteTab")}: ${tab.url}`,
      icon: tab.favicon ? (
        <img class="tabstrip-tab__favicon" src={tab.favicon} alt="" />
      ) : (
        <Icon name={sourceTabs()[index]?.kind === "native" ? "monitor" : "globe"} />
      ),
      closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
    })),
  );
  return (
    <PanelTabStrip
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
