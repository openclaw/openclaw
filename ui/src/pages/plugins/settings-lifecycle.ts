import { html, nothing, type TemplateResult } from "lit";
import { compareValidSemver } from "../../../../src/infra/semver.js";
import { icons } from "../../components/icons.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import { t } from "../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginInstallRequest,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { renderPluginAskAction } from "./overview.ts";
import { pluginRowKey } from "./plugin-row-message.ts";
import type { PluginMutationAction } from "./plugins-page-model.ts";

type PluginLifecycleProps = {
  inspection: PluginsInspectResult | null;
  catalog?: PluginDiscoveryDetailResult;
  onUpdate?: (request: PluginInstallRequest) => void;
  mutationBlockedReason: string | null;
  canMutate: boolean;
  busy: Readonly<Record<string, PluginMutationAction>>;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onSettings: () => void;
  settingsHref: string;
  onUninstall: (pluginId: string, rowKey: string) => void;
  onAskPlugin?: () => void;
};

export function renderPluginLifecycle(
  props: PluginLifecycleProps,
  plugin: PluginCatalogItem,
): TemplateResult {
  const catalog = props.catalog ?? props.inspection?.catalog;
  const packageName = catalog?.plugin.catalog.packageName;
  const version = catalog?.plugin.catalog.latestVersion;
  // Registry presentation alone must never change an installed plugin's source.
  const update =
    packageName &&
    props.inspection?.source?.kind === "clawhub" &&
    props.inspection.plugin.id === plugin.id &&
    props.inspection.source.packageName === packageName &&
    plugin.clawhubPackage === packageName &&
    plugin.catalogId === catalog?.plugin.id &&
    catalog?.detail.origin === "clawhub" &&
    plugin.installed &&
    plugin.version &&
    version &&
    (compareValidSemver(version, plugin.version) ?? 0) > 0
      ? {
          source: "clawhub" as const,
          packageName,
          version,
          expectedPluginId: plugin.id,
          mode: "update" as const,
          enable: false,
        }
      : undefined;
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
  // Keep the primary action first in visual and keyboard navigation order.
  const askAction = renderPluginAskAction(props.onAskPlugin, plugin.enabled);
  return html`
    ${plugin.enabled ? askAction : nothing}
    ${action(enableAction, t(enableAction === "disable" ? "pluginsPage.detailDisable" : "pluginsPage.detailEnable"), plugin.enabled ? "oc-action-secondary" : "primary oc-action-primary", props.mutationBlockedReason ?? (plugin.state === "needs-setup" ? t("pluginsPage.setupRequiredNotice") : null), props.canMutate && plugin.state !== "needs-setup", () => props.onSetEnabled(plugin.id, !plugin.enabled, key))}
    ${!plugin.enabled ? askAction : nothing}
    ${update && props.onUpdate ? action("update", t(pending === "update" ? "pluginsPage.updating" : "pluginsPage.updateVersion", { version: update.version }), "oc-action-secondary", props.mutationBlockedReason, props.canMutate, () => props.onUpdate?.(update)) : nothing}
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
