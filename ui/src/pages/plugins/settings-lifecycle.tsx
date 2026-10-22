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
export function PluginLifecycle(props: PluginLifecycleProps & { plugin: PluginCatalogItem }) {
  const key = () => pluginRowKey(props.plugin.id);
  const pending = () => props.busy[key()];
  const busy = () => Boolean(pending());
  const enableAction = () => {
    const current = pending();
    return current === "enable" || current === "disable"
      ? current
      : props.plugin.enabled
        ? "disable"
        : "enable";
  };
  function Action(action: {
    kind: PluginMutationAction;
    label: string;
    class: string;
    blockedReason: string | null;
    allowed: boolean;
    onClick: () => void;
  }) {
    return (
      <ReasonedDisabledControl reason={action.blockedReason}>
        <button
          type="button"
          class={["btn oc-action", action.class]}
          disabled={!action.blockedReason && (!action.allowed || busy())}
          aria-disabled={!action.allowed || busy() ? "true" : undefined}
          aria-label={`${action.label} ${props.plugin.name}`}
          aria-busy={pending() === action.kind ? "true" : undefined}
          onClick={() => {
            if (action.allowed && !busy()) {
              action.onClick();
            }
          }}
        >
          {pending() === action.kind ? <span class="btn__spinner" aria-hidden="true" /> : null}
          {action.label}
        </button>
      </ReasonedDisabledControl>
    );
  }
  // Keep the primary action first in visual and keyboard navigation order.
  const askAction = () => renderPluginAskAction(props.onAskPlugin, props.plugin.enabled);
  return (
    <>
      {props.plugin.enabled ? askAction() : null}
      <Action
        kind={enableAction()}
        label={t(
          enableAction() === "disable" ? "pluginsPage.detailDisable" : "pluginsPage.detailEnable",
        )}
        class={props.plugin.enabled ? "oc-action-secondary" : "primary oc-action-primary"}
        blockedReason={
          props.mutationBlockedReason ??
          (props.plugin.state === "needs-setup" ? t("pluginsPage.setupRequiredNotice") : null)
        }
        allowed={props.canMutate && props.plugin.state !== "needs-setup"}
        onClick={() => props.onSetEnabled(props.plugin.id, !props.plugin.enabled, key())}
      />
      {!props.plugin.enabled ? askAction() : null}
      {props.plugin.removable ? (
        <Action
          kind="uninstall"
          label={t("pluginsPage.uninstall")}
          class="oc-action-secondary"
          blockedReason={props.mutationBlockedReason}
          allowed={props.canMutate}
          onClick={() => props.onUninstall(props.plugin.id, key())}
        />
      ) : null}
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
