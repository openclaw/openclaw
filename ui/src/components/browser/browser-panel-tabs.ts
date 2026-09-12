import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import type { PanelHostedTab } from "../panel-hosted-tabs.ts";
import { renderPanelTabStrip, type PanelTabStripTab } from "../panel-tab-strip.ts";
import type { BrowserPanelTab } from "./browser-client.ts";

function tabLabel(tab: BrowserPanelTab): string {
  if (tab.title.trim()) {
    return tab.title.trim();
  }
  try {
    return new URL(tab.url).host || t("browser.untitledTab");
  } catch {
    return tab.url || t("browser.untitledTab");
  }
}

export function browserPanelHostedTabs(tabs: BrowserPanelTab[]): PanelHostedTab[] {
  return tabs.map((tab) => ({
    id: tab.id,
    label: tabLabel(tab),
    url: tab.url,
    favicon: tab.favicon,
    icon: tab.kind === "native" ? icons.monitor : icons.globe,
  }));
}

export function renderBrowserPanelTabs(params: {
  tabs: BrowserPanelTab[];
  activeTargetId: string | null;
  onSelect: (targetId: string) => void;
  onClose: (targetId: string) => void | Promise<void>;
  onNew: () => void;
  /** Embedded chrome hosts the new-tab action in its toolbar instead. */
  hideNewControl?: boolean;
}) {
  const tabs: PanelTabStripTab[] = browserPanelHostedTabs(params.tabs).map((tab, index) => ({
    id: tab.id,
    domId: `browser-tab-${tab.id}`,
    label: tab.label,
    title: `${t(params.tabs[index]?.kind === "native" ? "browser.nativeTab" : "browser.remoteTab")}: ${tab.url}`,
    icon: tab.favicon
      ? html`<img class="tabstrip-tab__favicon" src=${tab.favicon} alt="" />`
      : tab.icon,
    closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
  }));
  return renderPanelTabStrip({
    tabs,
    activeId: params.activeTargetId,
    ariaControls: "browser-tab-panel",
    onSelect: params.onSelect,
    onClose: params.onClose,
    onNew: params.onNew,
    newLabel: t("browser.newTab"),
    newTabAction: true,
    ...(params.hideNewControl ? { newControl: nothing } : {}),
  });
}
