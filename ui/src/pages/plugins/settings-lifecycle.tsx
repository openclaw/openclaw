import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderPluginAskAction } from "./overview.tsx";
import { pluginRowKey } from "./plugin-row-message.tsx";
import type { PluginMutationAction } from "./plugins-page-model.ts";
import { ReasonedDisabledControl } from "./reasoned-disabled-control.tsx";
type PluginLifecycleProps = {
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
): JSX.Element {
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
  ) => (
    <ReasonedDisabledControl reason={blockedReason}>
      <button
        type="button"
        class={`btn oc-action ${className}`}
        disabled={!blockedReason && (!allowed || busy)}
        aria-disabled={!allowed || busy ? "true" : undefined}
        aria-label={`${label} ${plugin.name}`}
        aria-busy={pending === kind ? "true" : undefined}
        onClick={() => {
          if (allowed && !busy) {
            onClick();
          }
        }}
      >
        {pending === kind ? (
          <>
            <span class="btn__spinner" aria-hidden="true" />
          </>
        ) : null}
        {label}
      </button>
    </ReasonedDisabledControl>
  );
  // Keep the primary action first in visual and keyboard navigation order.
  const askAction = renderPluginAskAction(props.onAskPlugin, plugin.enabled);
  return (
    <>
      {plugin.enabled ? askAction : null}
      {action(
        enableAction,
        t(enableAction === "disable" ? "pluginsPage.detailDisable" : "pluginsPage.detailEnable"),
        plugin.enabled ? "oc-action-secondary" : "primary oc-action-primary",
        props.mutationBlockedReason ??
          (plugin.state === "needs-setup" ? t("pluginsPage.setupRequiredNotice") : null),
        props.canMutate && plugin.state !== "needs-setup",
        () => props.onSetEnabled(plugin.id, !plugin.enabled, key),
      )}
      {!plugin.enabled ? askAction : null}
      {plugin.removable
        ? action(
            "uninstall",
            t("pluginsPage.uninstall"),
            "oc-action-secondary",
            props.mutationBlockedReason,
            props.canMutate,
            () => props.onUninstall(plugin.id, key),
          )
        : null}
      <a
        class="btn btn--icon oc-action oc-action-icon oc-action-secondary"
        href={props.settingsHref}
        aria-label={t("pluginsPage.detailSettings")}
        onClick={(event: MouseEvent) => {
          if (shouldHandleNavigationClick(event)) {
            event.preventDefault();
            props.onSettings();
          }
        }}
      >
        <Icon name="settings" />
      </a>
    </>
  );
}
