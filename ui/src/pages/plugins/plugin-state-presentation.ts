import { t } from "../../i18n/index.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";

export function pluginStatePresentation(plugin: PluginCatalogItem): {
  kind: "ok" | "warn" | "danger" | "muted";
  label: string;
} {
  switch (plugin.state) {
    case "enabled":
      return { kind: "ok", label: t("pluginsPage.enabled") };
    case "disabled":
      return { kind: "muted", label: t("pluginsPage.disabled") };
    case "needs-setup":
      return { kind: "warn", label: t("pluginsPage.setupRequired") };
    case "error":
      return { kind: "danger", label: t("pluginsPage.needsAttention") };
    case "not-installed":
      return { kind: "muted", label: t("pluginsPage.available") };
  }
  return plugin.state satisfies never;
}

export function matchesPluginQuery(plugin: PluginCatalogItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return (
    !needle ||
    [plugin.name, plugin.id, plugin.description, plugin.packageName].some((value) =>
      value?.toLocaleLowerCase().includes(needle),
    )
  );
}
