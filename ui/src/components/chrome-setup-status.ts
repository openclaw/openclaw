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
  failed: boolean;
}) {
  if (legacyResult && !running && !failed) {
    return html`<p role="status">
        ${t(legacyResult.nativeHostRegistered ? "configPage.deviceSettings.chromeExtensionPhases.waiting_for_connection" : "configPage.deviceSettings.chromeExtensionFailed")}
      </p>
      <p>
        ${t(legacyResult.installRequested || legacyResult.discoveredProfiles > 0 ? "configPage.deviceSettings.chromeExtensionNextActions.open_chrome" : "configPage.deviceSettings.chromeExtensionNextActions.install_from_store")}
      </p>`;
  }
  return html`
    <p role="status">
      ${
        running
          ? t("configPage.deviceSettings.chromeExtensionPreparing")
          : failed
            ? t("configPage.deviceSettings.chromeExtensionFailed")
            : result
              ? t(`configPage.deviceSettings.chromeExtensionPhases.${result.phase}`)
              : nothing
      }
    </p>
    ${
      result
        ? html`
            <p>
              ${t("configPage.deviceSettings.chromeExtensionTarget", {
                hostname: result.target.hostname,
                profile: result.target.profile,
                port: String(result.target.relayPort),
              })}
            </p>
            <p>${t(`configPage.deviceSettings.chromeExtensionNextActions.${result.nextAction}`)}</p>
            ${
              result.connection.state === "connected"
                ? html`<p>${t("configPage.deviceSettings.chromeExtensionTabsHint")}</p>`
                : nothing
            }
          `
        : nothing
    }
  `;
}
