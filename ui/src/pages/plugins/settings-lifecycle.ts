import { html, nothing, type TemplateResult } from "lit";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import { renderSettingsRow } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { PluginCatalogItem, PluginsInspectResult } from "../../lib/plugins/index.ts";
import { pluginOriginLabel } from "./consent-dialog.ts";
import { pluginRowKey } from "./plugin-row-message.ts";

type PluginLifecycleProps = {
  inspection: PluginsInspectResult | null;
  mutationBlockedReason: string | null;
  canMutate: boolean;
  reloadBlockedReason: string | null;
  busy: Readonly<Record<string, boolean>>;
  onReload: (pluginId: string, rowKey: string) => void;
  onUninstall: (pluginId: string, rowKey: string) => void;
};

export function renderPluginLifecycle(
  props: PluginLifecycleProps,
  plugin: PluginCatalogItem,
): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const source = props.inspection?.source;
  const trust = props.inspection?.trust;
  const reloadReason = props.reloadBlockedReason;
  const canReload = reloadReason === null;
  const rows = html`
    ${renderSettingsRow({
      title: t("pluginsPage.detailPluginId"),
      control: html`<code>${plugin.id}</code>`,
      carapace: true,
    })}
    ${
      plugin.version
        ? renderSettingsRow({
            title: t("pluginsPage.version"),
            control: html`<span>${`v${plugin.version}`}</span>`,
            carapace: true,
          })
        : nothing
    }
    ${
      plugin.packageName
        ? renderSettingsRow({
            title: t("pluginsPage.detailPackage"),
            control: html`<code>${plugin.packageName}</code>`,
            carapace: true,
          })
        : nothing
    }
    ${
      plugin.origin
        ? renderSettingsRow({
            title: t("pluginsPage.detailOrigin"),
            control: html`<span>${pluginOriginLabel(plugin.origin)}</span>`,
            carapace: true,
          })
        : nothing
    }
    ${
      source
        ? renderSettingsRow({
            title: t("pluginsPage.installedSource"),
            control: html`<span>${source.spec ?? source.packageName ?? source.kind}</span>`,
            carapace: true,
          })
        : nothing
    }
    ${
      source?.integrity
        ? renderSettingsRow({
            title: t("pluginsPage.integrity"),
            control: html`<code title=${source.integrity}>${source.integrity.slice(0, 20)}…</code>`,
            carapace: true,
          })
        : nothing
    }
    ${
      trust
        ? renderSettingsRow({
            title: t("pluginsPage.trustStatus"),
            control: html`<span>${trust.disposition}</span>`,
            carapace: true,
          })
        : nothing
    }
    ${renderSettingsRow({
      title: t("pluginsPage.reload"),
      description: t("pluginsPage.reloadHint"),
      control: renderReasonedDisabledControl(
        reloadReason,
        html`<button
          type="button"
          class="btn plugins-reload oc-action oc-action-secondary"
          ?disabled=${!reloadReason && (!canReload || Boolean(props.busy[key]))}
          aria-disabled=${!canReload ? "true" : nothing}
          aria-label=${t("pluginsPage.reloadNamed", { name: plugin.name })}
          @click=${() => {
            if (canReload && !props.busy[key]) {
              props.onReload(plugin.id, key);
            }
          }}
        >
          ${t("pluginsPage.reload")}
        </button>`,
      ),
      carapace: true,
    })}
    ${
      plugin.removable
        ? renderSettingsRow({
            title: t("pluginsPage.uninstall"),
            description: t("pluginsPage.uninstallDescription"),
            control: renderReasonedDisabledControl(
              props.mutationBlockedReason,
              html`<button
                type="button"
                class="btn danger oc-action oc-action-secondary"
                ?disabled=${
                  !props.mutationBlockedReason && (!props.canMutate || Boolean(props.busy[key]))
                }
                aria-disabled=${!props.canMutate ? "true" : nothing}
                aria-label=${t("pluginsPage.uninstallNamed", { name: plugin.name })}
                @click=${() => {
                  if (props.canMutate && !props.busy[key]) {
                    props.onUninstall(plugin.id, key);
                  }
                }}
              >
                ${t("pluginsPage.uninstall")}
              </button>`,
            ),
            carapace: true,
          })
        : renderSettingsRow({
            title: t("pluginsPage.uninstall"),
            description: t("pluginsPage.managedCannotUninstall"),
            carapace: true,
          })
    }
  `;
  return rows;
}
