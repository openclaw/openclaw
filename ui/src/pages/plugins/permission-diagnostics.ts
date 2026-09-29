import { html, nothing } from "lit";
import { pathForPluginSettings } from "../../app-route-paths.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import "./permission-diagnostics.css";

registerPluginManagementEnglish();

export function pluginPermissionLocation(pluginId: string, configPath: string, basePath = "") {
  const prefix = "plugins.entries." + pluginId + ".";
  const field = configPath.startsWith(prefix) ? configPath.slice(prefix.length) : "";
  return {
    pathname: pathForPluginSettings(pluginId, basePath),
    search: "?" + new URLSearchParams({ view: "settings", permission: field }).toString(),
  };
}

export function renderPluginPermissionNotice(
  plugin: PluginCatalogItem,
  onReview: (pluginId: string, configPath: string) => void,
  readonlyReason?: string | null,
) {
  const blocked = plugin.runtime?.blockedHooks ?? [];
  if (!blocked.length) {
    return nothing;
  }
  const paths = [...new Set(blocked.map((hook) => hook.configPath))];
  return html`<section
    class="callout warning plugins-permission-notice oc-banner oc-banner-warning"
    aria-label=${t("pluginsPage.permissions.blocked")}
  >
    <strong>${t("pluginsPage.permissions.blocked")}</strong>
    <p>${t("pluginsPage.permissions.registrationOnly")}</p>
    ${paths.map(
      (configPath) => html`<div>
        <p>
          <code
            >${blocked
              .filter((hook) => hook.configPath === configPath)
              .map((hook) => hook.hookName)
              .join(", ")}</code
          >
        </p>
        <p>
          ${t(blocked.some((hook) => hook.configPath === configPath && hook.reason === "conversation-access-missing") ? "pluginsPage.permissions.missing" : "pluginsPage.permissions.denied")}
        </p>
        <code>${configPath}</code>
        <button
          type="button"
          class="btn btn--sm oc-action oc-action-secondary"
          @click=${() => onReview(plugin.id, configPath)}
        >
          ${t("pluginsPage.permissions.review")}
        </button>
      </div>`,
    )}
    ${readonlyReason ? html`<p>${readonlyReason}</p>` : nothing}
  </section>`;
}
