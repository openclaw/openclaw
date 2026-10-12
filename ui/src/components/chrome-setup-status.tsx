import { createMemo, For } from "solid-js";
import type { NativeChromeExtensionSetupResult } from "../app/native-chrome-setup.ts";
import type { LegacyChromeInstallResult } from "../app/native-device-settings.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
registerEnglishCatalog(registerSettingsEnglish);

export type ChromeSetupStatusProps = {
  result: NativeChromeExtensionSetupResult | null;
  legacyResult?: LegacyChromeInstallResult | null;
  running: boolean;
  failed: "inspection" | "setup" | null;
};

export function ChromeSetupStatus(props: ChromeSetupStatusProps) {
  const paragraphs = createMemo(() => {
    const rows: { text: string; status?: boolean }[] = [];
    const add = (key: string, status?: boolean, params?: Record<string, string>) =>
      rows.push({ text: t(`configPage.deviceSettings.chromeExtension${key}`, params), status });
    if (props.failed === "inspection") {
      add("Unknown", true);
      add("StatusFailed");
    } else if (props.running || props.failed) {
      add(props.running ? "Preparing" : "Failed", true);
    } else {
      const result = props.result;
      const installation = result?.installation ?? props.legacyResult;
      if (!installation) {
        return rows;
      }
      const installed = (installation.installedProfiles ?? installation.discoveredProfiles) > 0;
      const known = installation.installedProfiles !== undefined;
      add(installed ? "Detected" : known ? "NotInstalled" : "Unknown", true);
      if (installed && installation.discoveredProfiles === 0) {
        add("EnableHint");
      }
      if (result) {
        add(`Phases.${result.phase}`, true);
        add("Target", false, {
          hostname: result.target.hostname,
          profile: result.target.profile,
          port: String(result.target.relayPort),
        });
        if (result.nextAction !== "none") {
          add(`NextActions.${result.nextAction}`);
        }
        if (result.connection.state === "connected") {
          add("TabsHint");
        }
      } else {
        add(installation.nativeHostRegistered ? "Phases.waiting_for_connection" : "Failed");
        if (installation.nativeHostRegistered && !installed) {
          add(
            installation.installRequested
              ? "NextActions.open_chrome"
              : known
                ? "NextActions.install_from_store"
                : "StatusUnsupported",
          );
        }
      }
    }
    return rows;
  });
  return (
    <For each={paragraphs()}>
      {(row) => <p role={row.status ? "status" : undefined}>{row.text}</p>}
    </For>
  );
}
