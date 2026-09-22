import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import { t } from "../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type { PluginCatalogItem, PluginsInspectResult } from "../../lib/plugins/index.ts";
import { pluginRowKey } from "./plugin-row-message.ts";
import type { PluginMutationAction } from "./plugins-page-model.ts";

type PluginLifecycleProps = {
  inspection: PluginsInspectResult | null;
  mutationBlockedReason: string | null;
  canMutate: boolean;
  busy: Readonly<Record<string, PluginMutationAction>>;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onSettings: () => void;
  settingsHref: string;
  onUninstall: (pluginId: string, rowKey: string) => void;
};

export function renderPluginLifecycle(
  props: PluginLifecycleProps,
  plugin: PluginCatalogItem,
): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const pending = props.busy[key];
  const busy = Boolean(pending);
  const enableAction =
    pending === "enable" || pending === "disable" ? pending : plugin.enabled ? "disable" : "enable";
  const action = (
    kind: PluginMutationAction,
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
        aria-label=${`${label} ${plugin.name}`}
        aria-busy=${pending === kind ? "true" : nothing}
        @click=${() => {
          if (allowed && !busy) {
            onClick();
          }
        }}
      >
        ${pending === kind ? html`<span class="btn__spinner" aria-hidden="true"></span>` : nothing}${label}
      </button>`,
    );
  return html`
    ${action(enableAction, t(enableAction === "disable" ? "pluginsPage.detailDisable" : "pluginsPage.detailEnable"), plugin.enabled ? "oc-action-secondary" : "primary oc-action-primary", props.mutationBlockedReason ?? (plugin.state === "needs-setup" ? t("pluginsPage.setupRequiredNotice") : null), props.canMutate && plugin.state !== "needs-setup", () => props.onSetEnabled(plugin.id, !plugin.enabled, key))}
    ${plugin.removable ? action("uninstall", t("pluginsPage.uninstall"), "oc-action-secondary", props.mutationBlockedReason, props.canMutate, () => props.onUninstall(plugin.id, key)) : nothing}
    <a
      class="btn btn--icon oc-action oc-action-icon oc-action-secondary"
      href=${props.settingsHref}
      aria-label=${t("pluginsPage.detailSettings")}
      @click=${(event: MouseEvent) => {
        if (shouldHandleNavigationClick(event)) {
          event.preventDefault();
          props.onSettings();
        }
      }}
      >${icons.settings}</a
    >
  `;
}
