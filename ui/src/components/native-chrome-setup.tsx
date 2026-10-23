import { createMemo, createSignal, Errored, For, onSettled, Show } from "solid-js";
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
