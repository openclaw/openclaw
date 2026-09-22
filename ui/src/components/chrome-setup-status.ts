import { html, nothing } from "lit";
import type { NativeChromeExtensionSetupResult } from "../app/native-chrome-setup.ts";
import type { LegacyChromeInstallResult } from "../app/native-device-settings.ts";
import { t } from "../i18n/index.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
registerSettingsEnglish();

export function renderChromeSetupStatus({
  result,
  legacyResult,
  running,
  failed,
}: {
  result: NativeChromeExtensionSetupResult | null;
  legacyResult?: LegacyChromeInstallResult | null;
  running: boolean;
  failed: "inspection" | "setup" | null;
}) {
  if (failed === "inspection") {
    return html`<p role="status">${t("configPage.deviceSettings.chromeExtensionUnknown")}</p>
      <p>${t("configPage.deviceSettings.chromeExtensionStatusFailed")}</p>`;
  }
  if (running || failed) {
    return html`<p role="status">
      ${t(running ? "configPage.deviceSettings.chromeExtensionPreparing" : "configPage.deviceSettings.chromeExtensionFailed")}
    </p>`;
  }
  const installation = result?.installation ?? legacyResult;
  if (!installation) {
    return nothing;
  }
  const installed = (installation.installedProfiles ?? installation.discoveredProfiles) > 0;
  return html`
    <p role="status">
      ${t(installed ? "configPage.deviceSettings.chromeExtensionDetected" : installation.installedProfiles === undefined ? "configPage.deviceSettings.chromeExtensionUnknown" : "configPage.deviceSettings.chromeExtensionNotInstalled")}
    </p>
    ${installed && installation.discoveredProfiles === 0 ? html`<p>${t("configPage.deviceSettings.chromeExtensionEnableHint")}</p>` : nothing}
    ${
      result
        ? html`
            <p role="status">
              ${t(`configPage.deviceSettings.chromeExtensionPhases.${result.phase}`)}
            </p>
            <p>
              ${t("configPage.deviceSettings.chromeExtensionTarget", {
                hostname: result.target.hostname,
                profile: result.target.profile,
                port: String(result.target.relayPort),
              })}
            </p>
            ${result.nextAction !== "none" ? html`<p>${t(`configPage.deviceSettings.chromeExtensionNextActions.${result.nextAction}`)}</p>` : nothing}
            ${
              result.connection.state === "connected"
                ? html`<p>${t("configPage.deviceSettings.chromeExtensionTabsHint")}</p>`
                : nothing
            }
          `
        : html`
            <p>
              ${t(installation.nativeHostRegistered ? "configPage.deviceSettings.chromeExtensionPhases.waiting_for_connection" : "configPage.deviceSettings.chromeExtensionFailed")}
            </p>
            ${!installation.nativeHostRegistered || installed ? nothing : html`<p>${t(installation.installRequested ? "configPage.deviceSettings.chromeExtensionNextActions.open_chrome" : installation.installedProfiles === undefined ? "configPage.deviceSettings.chromeExtensionStatusUnsupported" : "configPage.deviceSettings.chromeExtensionNextActions.install_from_store")}</p>`}
          `
    }
  `;
}
