import { Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Switch } from "../../components/solid/switch.tsx";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderPluginAskAction } from "./overview.tsx";
import { pluginRowKey } from "./plugin-row-message.tsx";
import type { PluginMutationAction } from "./plugins-page-model.ts";
import { ReasonedDisabledControl } from "./reasoned-disabled-control.tsx";
type PluginLifecycleProps = {
  mutationBlockedReason: string | null;
  canMutate: boolean;
  enabled: boolean;
  busy: Readonly<Record<string, PluginMutationAction>>;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onSettings: () => void;
  settingsHref: string;
  onUninstall: (pluginId: string, rowKey: string) => void;
  onAskPlugin?: () => void;
  /** First account the operator can still sign in to; it owns the primary action. */
  signInServer?: string;
  mcpLoginBusy?: boolean;
  onMcpLogin?: (serverName: string) => void;
};
export function PluginLifecycle(props: PluginLifecycleProps & { plugin: PluginCatalogItem }) {
  const key = () => pluginRowKey(props.plugin.id);
  const pending = () => props.busy[key()];
  const busy = () => Boolean(pending());
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
  const blockedReason = () =>
    props.mutationBlockedReason ??
    (props.plugin.state === "needs-setup" ? t("pluginsPage.setupRequiredNotice") : null);
  const canToggle = () => props.canMutate && props.plugin.state !== "needs-setup";
  const leading = () => Boolean(props.signInServer || props.onAskPlugin || props.plugin.removable);
  return (
    <>
      {/* After installation, sign-in takes the slot the Install action used. */}
      <Show when={props.signInServer}>
        {(serverName) => (
          <button
            type="button"
            class="btn primary plugin-catalog-detail__sign-in"
            aria-label={t("pluginsPage.auth.connectAccount", { name: serverName() })}
            disabled={props.mcpLoginBusy}
            onClick={() => props.onMcpLogin?.(serverName())}
          >
            {t("pluginsPage.auth.connect")}
          </button>
        )}
      </Show>
      {renderPluginAskAction(props.onAskPlugin, false)}
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
      {leading() ? (
        <span class="plugin-catalog-detail__actions-divider" aria-hidden="true" />
      ) : null}
      <ReasonedDisabledControl reason={blockedReason()}>
        <label class="plugin-catalog-detail__enabled">
          <span aria-hidden="true">
            {t(props.enabled ? "pluginsPage.enabled" : "pluginsPage.disabled")}
          </span>
          <Switch
            checked={props.enabled}
            ariaLabel={props.plugin.name}
            saving={!canToggle() || busy()}
            onChange={() => {
              if (!canToggle() || busy()) {
                return false;
              }
              props.onSetEnabled(props.plugin.id, !props.plugin.enabled, key());
              return undefined;
            }}
          />
        </label>
      </ReasonedDisabledControl>
      <a
        class="btn btn--icon oc-action oc-action-icon oc-action-ghost plugin-catalog-detail__settings"
        href={props.settingsHref}
        aria-label={t("pluginsPage.detailSettings")}
        onClick={(event: MouseEvent) => handleNavigationClick(event, () => props.onSettings())}
      >
        <Icon name="settings" />
      </a>
    </>
  );
}
