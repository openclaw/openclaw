import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { NativeChromeExtensionSetupAction } from "../app/native-chrome-setup.ts";
import type { LegacyChromeInstallResult } from "../app/native-device-settings.ts";
import { projectNativeDeviceSettings } from "../lib/reactive/application-native.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { ChromeSetupStatus, type ChromeSetupStatusProps } from "./chrome-setup-status.tsx";
import "./native-chrome-setup.css";

export function NativeChromeSetup() {
  let host!: HTMLElement;
  const capability = useOptionalApplication()?.nativeDeviceSettings;
  const projection = capability ? projectNativeDeviceSettings(capability) : undefined;
  const browser = () => projection?.read()?.browser;
  const [state, setState] = createSignal<ChromeSetupStatusProps>({
    running: false,
    failed: null,
    result: null,
    legacyResult: null,
  });
  let disposed = false;
  let pending = false;
  onCleanup(() => {
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
  const setup = async (action: NativeChromeExtensionSetupAction) => {
    if (!host.isConnected || !capability || pending || !actions().includes(action)) {
      return;
    }
    const isCurrent = () => !disposed && host.isConnected;
    pending = true;
    setState({ running: true, failed: null, result: null, legacyResult: null });
    try {
      if (browser()?.chromeSetupActions === undefined) {
        let legacyResult: LegacyChromeInstallResult;
        if (action === "inspect" && capability.chromeExtensionStatus) {
          legacyResult = await capability.chromeExtensionStatus();
        } else if (action === "install" && capability.installChromeExtension) {
          legacyResult = await capability.installChromeExtension();
        } else {
          return;
        }
        if (isCurrent() && actions().includes(action)) {
          setState((value) => ({ ...value, legacyResult }));
        }
      } else {
        const result = await capability.setupChromeExtension(action);
        if (isCurrent() && actions().includes(action)) {
          setState((value) => ({ ...value, result }));
        }
      }
    } catch {
      if (isCurrent()) {
        setState((value) => ({
          ...value,
          failed: "setup",
        }));
      }
    } finally {
      if (isCurrent()) {
        pending = false;
        setState((value) => ({ ...value, running: false }));
      }
    }
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
                  disabled={state().running}
                  onClick={() => void setup(action)}
                >
                  {t(`configPage.deviceSettings.${label}`)}
                </button>
              )}
            </For>
          </div>
          <ChromeSetupStatus
            result={state().result}
            legacyResult={state().legacyResult}
            running={state().running}
            failed={state().failed}
          />
        </div>
      </Show>
    </openclaw-native-chrome-setup>
  );
}
