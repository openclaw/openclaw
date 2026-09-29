import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import type { NativeDeviceSettingsSnapshot } from "../../app/native-device-settings.ts";
import { icons } from "../../components/icons.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

registerSettingsEnglish();

class DevicePermissionsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.nativeDeviceSettings,
    (capability, notify) => capability.subscribe(notify),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private renderPermissions(snapshot: NativeDeviceSettingsSnapshot) {
    const capability = this.context.nativeDeviceSettings;
    const { permissions } = snapshot;
    const location = permissions.location;
    const preciseEditable = location?.preciseEditable ?? snapshot.device.platform === "macos";
    return html`
      ${
        permissions.entries.length > 0
          ? renderSettingsSection(
              { title: t("configPage.deviceSettings.systemAccess") },
              permissions.entries.map(({ id, status }) => {
                const permissionTitle = t(`configPage.deviceSettings.permissions.${id}.title`);
                const requestableBinaryPermission =
                  snapshot.device.platform === "macos" &&
                  (id === "screenRecording" || id === "accessibility") &&
                  status === "notDetermined";
                return renderSettingsRow({
                  title: permissionTitle,
                  description: t(`configPage.deviceSettings.permissions.${id}.hint`),
                  stackedOnNarrow: true,
                  control: html`
                    <div class="settings-permission-control">
                      ${renderSettingsStatus({
                        kind: "muted",
                        dot: false,
                        label: html`${status === "granted" ? html`<span class="settings-permission-check" aria-hidden="true">${icons.check}</span>` : nothing}${t(`configPage.deviceSettings.permissionStatuses.${requestableBinaryPermission ? "notGranted" : status}`)}`,
                      })}
                      ${status === "notDetermined" ? html`<button type="button" class="btn" aria-label=${`${t("configPage.deviceSettings.grant")}: ${permissionTitle}`} @click=${() => capability?.requestPermission(id)}>${t("configPage.deviceSettings.grant")}</button>` : status === "denied" ? html`<button type="button" class="btn" aria-label=${`${t("configPage.deviceSettings.openSystemSettings")}: ${permissionTitle}`} @click=${() => capability?.openSystemSettings(id)}>${t("configPage.deviceSettings.openSystemSettings")}</button>` : nothing}
                      ${requestableBinaryPermission ? html`<button type="button" class="btn settings-permission-recovery" aria-label=${`${t("configPage.deviceSettings.openSystemSettings")}: ${permissionTitle}`} @click=${() => capability?.openSystemSettings(id)}>${t("configPage.deviceSettings.openSystemSettings")}</button>` : nothing}
                    </div>
                  `,
                });
              }),
            )
          : nothing
      }
      ${
        location
          ? renderSettingsSection(
              { title: t("configPage.deviceSettings.location") },
              html`
                ${renderSettingsRow({
                  title: t("configPage.deviceSettings.locationAccess"),
                  description: t("configPage.deviceSettings.locationHint"),
                  stackedOnNarrow: true,
                  control: renderSettingsSegmented({
                    value: location.mode,
                    ariaLabel: t("configPage.deviceSettings.locationAccess"),
                    options: ["off", "whileUsing", "always"].map((value) => ({
                      value,
                      label: t(`configPage.deviceSettings.locationModes.${value}`),
                    })),
                    onChange: (value) => capability?.set("permissions.location.mode", value),
                  }),
                })}
                ${
                  !preciseEditable
                    ? renderSettingsRow({
                        title: t("configPage.deviceSettings.preciseLocation"),
                        description: t("configPage.deviceSettings.preciseLocationReadOnlyHint"),
                        stackedOnNarrow: true,
                        control: html`
                          <div class="settings-permission-control">
                            ${renderSettingsStatus({ kind: "muted", dot: false, label: t(location.precise ? "configPage.deviceSettings.preciseLocationStatuses.enabled" : "configPage.deviceSettings.preciseLocationStatuses.disabled") })}
                            <button
                              type="button"
                              class="btn"
                              aria-label=${`${t("configPage.deviceSettings.openSettings")}: ${t("configPage.deviceSettings.preciseLocation")}`}
                              @click=${() => capability?.openSystemSettings("location")}
                            >
                              ${t("configPage.deviceSettings.openSettings")}
                            </button>
                          </div>
                        `,
                      })
                    : renderSettingsToggleRow({
                        title: t("configPage.deviceSettings.preciseLocation"),
                        description: t("configPage.deviceSettings.preciseLocationHint"),
                        checked: location.precise,
                        disabled: location.mode === "off",
                        onChange: (value) => capability?.set("permissions.location.precise", value),
                      })
                }
              `,
            )
          : nothing
      }
      ${
        snapshot.capabilities?.activeComputerPresenceEnabled !== undefined
          ? renderSettingsSection(
              { title: t("configPage.deviceSettings.privacy") },
              renderSettingsToggleRow({
                title: t("configPage.deviceSettings.activePresence"),
                description: t("configPage.deviceSettings.activePresenceHint"),
                checked: snapshot.capabilities.activeComputerPresenceEnabled,
                onChange: (value) =>
                  capability?.set("capabilities.activeComputerPresenceEnabled", value),
              }),
            )
          : nothing
      }
    `;
  }

  override render() {
    const capability = this.context?.nativeDeviceSettings;
    const snapshot = capability?.snapshot;
    const body = !capability
      ? renderSettingsEmpty(t("configPage.deviceSettings.appOnly"))
      : snapshot
        ? this.renderPermissions(snapshot)
        : renderSettingsEmpty(t("configPage.deviceSettings.loading"));
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("device-permissions"),
        subtitle: html`${t(snapshot?.device.platform === "macos" ? "configPage.deviceSettings.permissionsIntro" : "configPage.deviceSettings.permissionsIntroIos")}
        ${renderLearnMoreLink(`https://docs.openclaw.ai/platforms/${snapshot?.device.platform ?? "macos"}`)}`,
      })}
      ${renderSettingsWorkspace(renderSettingsPage(body))}
    `;
  }
}

if (!customElements.get("openclaw-device-permissions-page")) {
  customElements.define("openclaw-device-permissions-page", DevicePermissionsPage);
}
