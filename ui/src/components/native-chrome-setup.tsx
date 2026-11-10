import { createMemo, createSignal, Errored, For, onSettled, Show } from "solid-js";
import type {
  NativeChromeExtensionSetupAction,
  NativeChromeExtensionSetupResult,
} from "../app/native-chrome-setup.ts";
import type { LegacyChromeInstallResult } from "../app/native-device-settings.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { projectNativeDeviceSettings } from "../lib/reactive/application-native.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import "./native-chrome-setup.css";

registerEnglishCatalog(registerSettingsEnglish);

type ChromeSetupStatusProps = {
  result: NativeChromeExtensionSetupResult | null;
  legacyResult?: LegacyChromeInstallResult | null;
  running: boolean;
  failed: "inspection" | "setup" | null;
};

function ChromeSetupStatus(props: ChromeSetupStatusProps) {
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

export function NativeChromeSetup() {
  let host!: HTMLElement;
  const capability = useOptionalApplication()?.nativeDeviceSettings;
  const projection = capability ? projectNativeDeviceSettings(capability) : undefined;
  const browser = () => projection?.read()?.browser;
  // Native setup has no synchronous view-retirement signal; an action can hold the next mount.
  const [running, setRunning] = createSignal(false);
  const [attempt, setAttempt] =
    createSignal<Promise<Pick<ChromeSetupStatusProps, "result" | "legacyResult"> | undefined>>();
  const outcome = createMemo(() => attempt(), {
    loadingValue: undefined,
  });
  let disposed = false;
  // Native admission must close synchronously, before Solid presents the running state.
  let pending = false;
  onSettled(() => () => {
    disposed = true;
  });
  const actions = createMemo<readonly NativeChromeExtensionSetupAction[]>(() => {
    const available = browser();
    if (!available || !capability) {
      return [];
    }
    if (available.chromeSetupActions) {
      return available.chromeSetupActions;
    }
    if (projection?.read()?.device.platform !== "macos") {
      return [];
    }
    return capability.installChromeExtension ? ["install"] : [];
  });
  const runSetup = async (
    selected: NativeChromeExtensionSetupAction,
    settings: NonNullable<typeof capability>,
  ) => {
    const isCurrent = () => !disposed && host.isConnected;
    setRunning(true);
    try {
      if (browser()?.chromeSetupActions === undefined) {
        let legacyResult: LegacyChromeInstallResult;
        if (selected === "inspect" && settings.chromeExtensionStatus) {
          legacyResult = await settings.chromeExtensionStatus();
        } else if (selected === "install" && settings.installChromeExtension) {
          legacyResult = await settings.installChromeExtension();
        } else {
          return undefined;
        }
        if (isCurrent() && actions().includes(selected)) {
          return { result: null, legacyResult };
        }
      } else {
        const result = await settings.setupChromeExtension(selected);
        if (isCurrent() && actions().includes(selected)) {
          return { result, legacyResult: null };
        }
      }
    } catch (error) {
      if (isCurrent()) {
        throw error;
      }
    } finally {
      if (isCurrent()) {
        pending = false;
        setRunning(false);
      }
    }
    return undefined;
  };
  const setup = (selected: NativeChromeExtensionSetupAction) => {
    if (!host.isConnected || !capability || pending || !actions().includes(selected)) {
      return;
    }
    pending = true;
    const result = runSetup(selected, capability);
    // Consume failures even when the native setup view retires before observing the outcome.
    void result.catch(() => {});
    void setAttempt(result);
  };
  const visibleActions = () =>
    (
      [
        ["install", "chromeExtensionSetup"],
        ["inspect", "chromeExtensionRefresh"],
        ["verify", "chromeExtensionVerify"],
      ] as const
    ).filter(([action]) => actions().includes(action));
  return (
    <openclaw-native-chrome-setup ref={(element) => (host = element)}>
      <Show when={browser()}>
        <div class="native-chrome-setup">
          <p>{t("configPage.deviceSettings.chromeExtensionHint")}</p>
          <div class="native-chrome-setup__actions">
            <For each={visibleActions()}>
              {([action, label]) => (
                <button
                  type="button"
                  class="btn"
                  disabled={running()}
                  onClick={() => setup(action)}
                >
                  {t(`configPage.deviceSettings.${label}`)}
                </button>
              )}
            </For>
          </div>
          <Show
            when={!running()}
            fallback={<ChromeSetupStatus result={null} running={true} failed={null} />}
          >
            <Errored fallback={<ChromeSetupStatus result={null} running={false} failed="setup" />}>
              <ChromeSetupStatus
                result={outcome()?.result ?? null}
                legacyResult={outcome()?.legacyResult}
                running={false}
                failed={null}
              />
            </Errored>
          </Show>
        </div>
      </Show>
    </openclaw-native-chrome-setup>
  );
}
