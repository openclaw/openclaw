import { t } from "../../i18n/index.ts";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { createIconElement } from "../markdown-icon.ts";
import type { PanelHostedTab } from "../panel-hosted-tabs.ts";
import type { BrowserPanelTab } from "./browser-client.ts";

registerBrowserEnglish();

export function browserPanelHostedTabs(tabs: BrowserPanelTab[], ownerDocument: Document) {
  return tabs.map((tab) => ({
    id: tab.id,
    label: tab.title.trim() || (URL.parse(tab.url)?.host ?? tab.url) || t("browser.untitledTab"),
    url: tab.url,
    favicon: tab.favicon,
    icon: createIconElement(tab.kind === "native" ? "monitor" : "globe", ownerDocument),
  })) satisfies PanelHostedTab[];
}
