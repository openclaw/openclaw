import { t } from "../../i18n/index.ts";
import { createIconElement } from "../markdown-icon.ts";
import type { PanelHostedTab } from "../panel-hosted-tabs.ts";
import type { BrowserPanelTab } from "./browser-client.ts";

function tabLabel(tab: BrowserPanelTab): string {
  return tab.title.trim() || (URL.parse(tab.url)?.host ?? tab.url) || t("browser.untitledTab");
}

export function browserPanelHostedTabs(tabs: BrowserPanelTab[], ownerDocument: Document) {
  return tabs.map((tab) => ({
    id: tab.id,
    label: tabLabel(tab),
    url: tab.url,
    favicon: tab.favicon,
    icon: createIconElement(tab.kind === "native" ? "monitor" : "globe", ownerDocument),
  })) satisfies PanelHostedTab[];
}
