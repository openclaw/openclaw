import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import { t } from "../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type { PluginCatalogItem, PluginsInspectResult } from "../../lib/plugins/index.ts";
import { pluginRowKey } from "./plugin-row-message.ts";

type PluginLifecycleProps = {
  inspection: PluginsInspectResult | null;
  mutationBlockedReason: string | null;
  canMutate: boolean;
  reloadBlockedReason: string | null;
  busy: Readonly<Record<string, boolean>>;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onSettings: () => void;
  settingsHref: string;
  onReload: (pluginId: string, rowKey: string) => void;
  onUninstall: (pluginId: string, rowKey: string) => void;
};

export function renderPluginLifecycle(
  props: PluginLifecycleProps,
  plugin: PluginCatalogItem,
): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const busy = Boolean(props.busy[key]);
  const canReload = props.reloadBlockedReason === null;
  const action = (
    label: string,
    className: string,
    blockedReason: string | null,
    allowed: boolean,
    onClick: () => void,
  ) =>
    renderReasonedDisabledControl(
      blockedReason,
      html`<button
        type="button"
        class=${`btn oc-action ${className}`}
        ?disabled=${!blockedReason && (!allowed || busy)}
        aria-disabled=${!allowed || busy ? "true" : nothing}
        aria-label=${className.includes("plugins-reload") ? t("pluginsPage.reloadNamed", { name: plugin.name }) : `${label} ${plugin.name}`}
        title=${className.includes("plugins-reload") ? t("pluginsPage.reloadHint") : nothing}
        @click=${() => {
          if (allowed && !busy) {
            onClick();
          }
        }}
      >
        ${label}
      </button>`,
    );
  return html`
    <a
      class="btn primary oc-action oc-action-primary"
      href=${props.settingsHref}
      @click=${(event: MouseEvent) => {
        if (shouldHandleNavigationClick(event)) {
          event.preventDefault();
          props.onSettings();
        }
      }}
      >${icons.settings} ${t("pluginsPage.detailSettings")}</a
    >
    ${action(t(plugin.enabled ? "pluginsPage.detailDisable" : "pluginsPage.detailEnable"), "oc-action-secondary", props.mutationBlockedReason ?? (plugin.state === "needs-setup" ? t("pluginsPage.setupRequiredNotice") : null), props.canMutate && plugin.state !== "needs-setup", () => props.onSetEnabled(plugin.id, !plugin.enabled, key))}
    ${action(t("pluginsPage.detailReload"), "plugins-reload oc-action-secondary", props.reloadBlockedReason, canReload, () => props.onReload(plugin.id, key))}
    ${plugin.removable ? action(t("pluginsPage.uninstall"), "oc-action-secondary", props.mutationBlockedReason, props.canMutate, () => props.onUninstall(plugin.id, key)) : nothing}
  `;
}
