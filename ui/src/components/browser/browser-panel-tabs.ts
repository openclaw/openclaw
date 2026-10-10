import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import type { PanelHostedTab } from "../panel-hosted-tabs.ts";
import type { BrowserPanelTab } from "./browser-client.ts";

function tabLabel(tab: BrowserPanelTab): string {
  return tab.title.trim() || (URL.parse(tab.url)?.host ?? tab.url) || t("browser.untitledTab");
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
