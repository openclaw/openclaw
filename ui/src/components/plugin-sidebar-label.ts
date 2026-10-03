import { t } from "../i18n/index.ts";

/** Localize built-in plugin navigation without changing plugin-owned IDs or labels. */
export function pluginSidebarLabel(pluginId: string, id: string, label: string): string {
  if (pluginId === "logbook" && id === "logbook") {
    return t("tabs.logs");
  }
  if (pluginId === "workboard" && id === "workboard") {
    return t("tabs.workboard");
  }
  return label;
}
