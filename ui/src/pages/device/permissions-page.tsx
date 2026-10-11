import { For, Show } from "solid-js";
import { titleForRoute } from "../../app-navigation.ts";
import type { NativeDeviceSettingsSnapshot } from "../../app/native-device-settings.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsStatus,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";

registerEnglishCatalog(registerSettingsEnglish);

function DevicePermissionsPageContent() {
  const capability = useApplication().nativeDeviceSettings;
  const projection = capability ? projectNativeDeviceSettings(capability) : null;
  const snapshot = () => projection?.read();

  function Permissions(props: { snapshot: NativeDeviceSettingsSnapshot }) {
    const location = () => props.snapshot.permissions.location;
    const preciseEditable = () =>
      location()?.preciseEditable ?? props.snapshot.device.platform === "macos";
    return (
      <>
        <Show when={props.snapshot.permissions.entries.length > 0}>
          <SettingsSection title={t("configPage.deviceSettings.systemAccess")}>
            <For each={props.snapshot.permissions.entries} keyed={(entry) => entry.id}>
              {(_entry, index) => {
                const permission = () => props.snapshot.permissions.entries[index()]!;
                const permissionTitle = () =>
                  t(`configPage.deviceSettings.permissions.${permission().id}.title`);
                const requestableBinaryPermission = () =>
                  props.snapshot.device.platform === "macos" &&
                  (permission().id === "screenRecording" || permission().id === "accessibility") &&
                  permission().status === "notDetermined";
                return (
                  <SettingsRow
                    title={permissionTitle()}
                    description={t(`configPage.deviceSettings.permissions.${permission().id}.hint`)}
                    stackedOnNarrow
                    control={
                      <div class="settings-permission-control">
                        <SettingsStatus
                          kind="muted"
                          dot={false}
                          label={
                            <>
                              <Show when={permission().status === "granted"}>
                                <span class="settings-permission-check" aria-hidden="true">
                                  <Icon name="check" />
                                </span>
                              </Show>
                              {t(
                                `configPage.deviceSettings.permissionStatuses.${requestableBinaryPermission() ? "notGranted" : permission().status}`,
                              )}
                            </>
                          }
                        />
                        <Show
                          when={permission().status === "notDetermined"}
                          fallback={
                            <Show when={permission().status === "denied"}>
                              <button
                                type="button"
                                class="btn"
                                aria-label={`${t("configPage.deviceSettings.openSystemSettings")}: ${permissionTitle()}`}
                                onClick={() => capability?.openSystemSettings(permission().id)}
                              >
                                {t("configPage.deviceSettings.openSystemSettings")}
                              </button>
                            </Show>
                          }
                        >
                          <button
                            type="button"
                            class="btn"
                            aria-label={`${t("configPage.deviceSettings.grant")}: ${permissionTitle()}`}
                            onClick={() => capability?.requestPermission(permission().id)}
                          >
                            {t("configPage.deviceSettings.grant")}
                          </button>
                        </Show>
                        <Show when={requestableBinaryPermission()}>
                          <button
                            type="button"
                            class="btn settings-permission-recovery"
                            aria-label={`${t("configPage.deviceSettings.openSystemSettings")}: ${permissionTitle()}`}
                            onClick={() => capability?.openSystemSettings(permission().id)}
                          >
                            {t("configPage.deviceSettings.openSystemSettings")}
                          </button>
                        </Show>
                      </div>
                    }
                  />
                );
              }}
            </For>
          </SettingsSection>
        </Show>
        <Show when={Boolean(location())}>
          <SettingsSection title={t("configPage.deviceSettings.location")}>
            <SettingsRow
              title={t("configPage.deviceSettings.locationAccess")}
              description={t("configPage.deviceSettings.locationHint")}
              stackedOnNarrow
              control={
                <SettingsSegmented
                  value={location()!.mode}
                  ariaLabel={t("configPage.deviceSettings.locationAccess")}
                  options={["off", "whileUsing", "always"].map((value) => ({
                    value,
                    label: t(`configPage.deviceSettings.locationModes.${value}`),
                  }))}
                  onChange={(value) => capability?.set("permissions.location.mode", value)}
                />
              }
            />
            <Show
              when={preciseEditable()}
              fallback={
                <SettingsRow
                  title={t("configPage.deviceSettings.preciseLocation")}
                  description={t("configPage.deviceSettings.preciseLocationReadOnlyHint")}
                  stackedOnNarrow
                  control={
                    <div class="settings-permission-control">
                      <SettingsStatus
                        kind="muted"
                        dot={false}
                        label={t(
                          location()!.precise
                            ? "configPage.deviceSettings.preciseLocationStatuses.enabled"
                            : "configPage.deviceSettings.preciseLocationStatuses.disabled",
                        )}
                      />
                      <button
                        type="button"
                        class="btn"
                        aria-label={`${t("configPage.deviceSettings.openSettings")}: ${t("configPage.deviceSettings.preciseLocation")}`}
                        onClick={() => capability?.openSystemSettings("location")}
                      >
                        {t("configPage.deviceSettings.openSettings")}
                      </button>
                    </div>
                  }
                />
              }
            >
              <SettingsToggleRow
                title={t("configPage.deviceSettings.preciseLocation")}
                description={t("configPage.deviceSettings.preciseLocationHint")}
                checked={location()!.precise}
                disabled={location()!.mode === "off"}
                onChange={(value) => capability?.set("permissions.location.precise", value)}
              />
            </Show>
          </SettingsSection>
        </Show>
        <Show when={props.snapshot.capabilities?.activeComputerPresenceEnabled !== undefined}>
          <SettingsSection title={t("configPage.deviceSettings.privacy")}>
            <SettingsToggleRow
              title={t("configPage.deviceSettings.activePresence")}
              description={t("configPage.deviceSettings.activePresenceHint")}
              checked={props.snapshot.capabilities?.activeComputerPresenceEnabled ?? false}
              onChange={(value) =>
                capability?.set("capabilities.activeComputerPresenceEnabled", value)
              }
            />
          </SettingsSection>
        </Show>
      </>
    );
  }
  return (
    <>
      <SettingsPageHeader
        title={titleForRoute("device-permissions", t)}
        subtitle={
          <>
            {t(
              snapshot()?.device.platform === "macos"
                ? "configPage.deviceSettings.permissionsIntro"
                : "configPage.deviceSettings.permissionsIntroIos",
            )}{" "}
            <LearnMoreLink
              url={`https://docs.openclaw.ai/platforms/${snapshot()?.device.platform ?? "macos"}`}
            />
          </>
        }
      />
      <SettingsWorkspace>
        <SettingsPage>
          <Show
            when={capability}
            fallback={<SettingsEmpty message={t("configPage.deviceSettings.appOnly")} />}
          >
            <Show
              when={Boolean(snapshot())}
              fallback={<SettingsEmpty message={t("configPage.deviceSettings.loading")} />}
            >
              <Permissions snapshot={snapshot()!} />
            </Show>
          </Show>
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}

export const DevicePermissionsPage = defineSolidBridge(
  "openclaw-device-permissions-page",
  DevicePermissionsPageContent,
  { properties: {} },
);
