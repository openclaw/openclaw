import { Show } from "solid-js";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import type { NativeDeviceSettingsSnapshot } from "../../app/native-device-settings.ts";
import { SettingsRow, SettingsStatus, SettingsValue } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { NotificationsSectionProps } from "./notifications-section.tsx";
import { COMMUNICATION_SETTINGS_TARGET_IDS } from "./settings-targets.ts";

registerEnglishCatalog(registerSettingsEnglish);

export function NativeDeviceNotificationSection(props: {
  device: NativeDeviceSettingsSnapshot | null;
  actions: NotificationsSectionProps;
}) {
  const permissionLabel = () => {
    const device = props.device;
    const permission = device?.permissions.entries.find((entry) => entry.id === "notifications");
    return device
      ? t(`configPage.deviceSettings.permissionStatuses.${permission?.status ?? "unavailable"}`)
      : t("configView.notifications.checking");
  };
  const enabled = () => props.device?.app?.notificationsEnabled;
  return (
    <section class="settings-section" id={COMMUNICATION_SETTINGS_TARGET_IDS.notifications}>
      <div class="settings-section__header">
        <h2 class="settings-section__heading">{t("configView.notifications.nativeTitle")}</h2>
        <div class="settings-section__actions">
          <SettingsStatus kind="muted" label={permissionLabel()} />
        </div>
      </div>
      <div class="settings-group">
        <Show
          when={props.device}
          fallback={
            <div class="settings-row">
              <span class="settings-row__desc">{t("configPage.deviceSettings.loading")}</span>
            </div>
          }
        >
          {(device) => (
            <>
              <SettingsRow
                title={t("configView.notifications.deviceDelivery")}
                control={
                  <SettingsValue
                    value={
                      enabled() === undefined
                        ? t("configView.notifications.unavailable")
                        : t(enabled() ? "common.enabled" : "common.disabled")
                    }
                  />
                }
              />
              <SettingsRow
                title={t("configView.notifications.permission")}
                control={<SettingsValue value={permissionLabel()} />}
              />
              <div class="settings-row">
                <div class="settings-row__control">
                  <a
                    class="btn"
                    href={props.actions.deviceSettingsHref}
                    onClick={(event) => {
                      if (
                        !props.actions.onOpenDeviceSettings ||
                        !shouldHandleNavigationClick(event)
                      ) {
                        return;
                      }
                      event.preventDefault();
                      props.actions.onOpenDeviceSettings();
                    }}
                  >
                    {t(deviceSettingsGroupLabelKey(device()))}
                  </a>
                  <a
                    class="btn"
                    href={props.actions.devicePermissionsHref}
                    onClick={(event) => {
                      if (
                        !props.actions.onOpenDevicePermissions ||
                        !shouldHandleNavigationClick(event)
                      ) {
                        return;
                      }
                      event.preventDefault();
                      props.actions.onOpenDevicePermissions();
                    }}
                  >
                    {t("configView.notifications.devicePermissions")}
                  </a>
                </div>
              </div>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}
