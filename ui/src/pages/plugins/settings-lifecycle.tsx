import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsGroup,
  SettingsRow,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
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
  icon?: JSX.Element;
  identity?: JSX.Element;
};
export function PluginLifecycle(props: PluginLifecycleProps & { plugin: PluginCatalogItem }) {
  const key = () => pluginRowKey(props.plugin.id);
  const pending = () => props.busy[key()];
  const busy = () => Boolean(pending());
  const allowed = () => props.canMutate && props.plugin.state !== "needs-setup";
  const blockedReason = () =>
    props.mutationBlockedReason ??
    (props.plugin.state === "needs-setup" ? t("pluginsPage.setupRequiredNotice") : null);
  return (
    <SettingsGroup carapace>
      <SettingsToggleRow
        icon={
          <div class="plugin-catalog-detail__icon" aria-hidden="true">
            {props.icon}
          </div>
        }
        title={
          props.plugin.state === "error"
            ? t("pluginsPage.needsAttention")
            : t(props.enabled ? "pluginsPage.enabled" : "pluginsPage.disabled")
        }
        description={
          blockedReason() || props.identity ? (
            <>
              {blockedReason() ? (
                <span class="plugin-lifecycle__reason">{blockedReason()}</span>
              ) : null}
              {props.identity}
            </>
          ) : undefined
        }
        ariaLabel={props.plugin.name}
        checked={props.enabled}
        // A blocked switch stays focusable, the way the button it replaced did.
        disabled={!allowed() && !blockedReason()}
        saving={busy() || !allowed()}
        onChange={(enabled) => {
          // The switch moves with the presented state, not before a consent review.
          props.onSetEnabled(props.plugin.id, enabled, key());
          return false;
        }}
      />
      {props.plugin.version || props.plugin.removable ? (
        <SettingsRow
          carapace
          title={t(
            props.plugin.version
              ? "pluginsPage.detailInstalledVersion"
              : "pluginsPage.settingsInstalled",
          )}
          control={
            <>
              {props.plugin.version ? <SettingsValue value={props.plugin.version} /> : null}
              {props.plugin.removable ? (
                <ReasonedDisabledControl reason={props.mutationBlockedReason}>
                  <button
                    type="button"
                    class="btn btn--sm oc-action oc-action-secondary"
                    disabled={!props.mutationBlockedReason && (!props.canMutate || busy())}
                    aria-disabled={!props.canMutate || busy() ? "true" : undefined}
                    aria-label={`${t("pluginsPage.uninstall")} ${props.plugin.name}`}
                    aria-busy={pending() === "uninstall" ? "true" : undefined}
                    onClick={() => {
                      if (props.canMutate && !busy()) {
                        props.onUninstall(props.plugin.id, key());
                      }
                    }}
                  >
                    {pending() === "uninstall" ? (
                      <span class="btn__spinner" aria-hidden="true" />
                    ) : null}
                    {t("pluginsPage.uninstall")}
                  </button>
                </ReasonedDisabledControl>
              ) : null}
            </>
          }
        />
      ) : null}
      <a
        class="settings-row settings-row--nav oc-settings-row"
        href={props.settingsHref}
        onClick={(event: MouseEvent) => handleNavigationClick(event, () => props.onSettings())}
      >
        <div class="settings-row__text oc-settings-row-content">
          <span class="settings-row__title oc-settings-row-title">
            {t("pluginsPage.detailSettings")}
          </span>
        </div>
        <div class="settings-row__control oc-settings-row-control">
          <span class="settings-row__chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
        </div>
      </a>
    </SettingsGroup>
  );
}
