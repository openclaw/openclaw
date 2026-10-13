import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { NativeChromeExtensionSetupAction } from "../app/native-chrome-setup.ts";
import type { LegacyChromeInstallResult } from "../app/native-device-settings.ts";
import { projectNativeDeviceSettings } from "../lib/reactive/application-native.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { ChromeSetupStatus, type ChromeSetupStatusProps } from "./chrome-setup-status.tsx";
import "./native-chrome-setup.css";

const resetOnDisconnect = new WeakMap<HTMLElement, () => void>();
type Props = { autoInspect: boolean };
function NativeChromeSetupContent(props: Props, host: HTMLElement) {
  const capability = useOptionalApplication()?.nativeDeviceSettings;
  const projection = capability ? projectNativeDeviceSettings(capability) : undefined;
  const browser = () => projection?.read()?.browser;
  const [state, setState] = createSignal<ChromeSetupStatusProps>({
    running: false,
    failed: null,
    result: null,
    legacyResult: null,
  });
  let generation = 0;
  let pending = false;
  const reset = () => {
    generation++;
    pending = false;
    setState({ running: false, failed: null, result: null, legacyResult: null });
  };
  resetOnDisconnect.set(host, reset);
  onCleanup(() => {
    generation++;
    resetOnDisconnect.delete(host);
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
    return [
      ...(capability.installChromeExtension ? ["install" as const] : []),
      ...(props.autoInspect && capability.chromeExtensionStatus ? ["inspect" as const] : []),
    ];
  });
  const needsInstall = () => {
    const installation = state().result?.installation ?? state().legacyResult;
    return (
      !installation ||
      !installation.nativeHostRegistered ||
      (installation.installedProfiles ?? installation.discoveredProfiles) === 0
    );
  };
  const setup = async (action: NativeChromeExtensionSetupAction) => {
    if (!host.isConnected || !capability || pending || !actions().includes(action)) {
      return;
    }
    const current = ++generation;
    const isCurrent = () => host.isConnected && generation === current;
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
          failed: props.autoInspect && action === "inspect" ? "inspection" : "setup",
        }));
      }
    } finally {
      if (isCurrent()) {
        pending = false;
        setState((value) => ({ ...value, running: false }));
      }
    }
  };
  createEffect(
    () => props.autoInspect && Boolean(browser()),
    (inspect) => {
      if (!inspect) {
        return undefined;
      }
      const refresh = () => void setup("inspect");
      window.addEventListener("focus", refresh);
      refresh();
      return () => {
        window.removeEventListener("focus", refresh);
        reset();
      };
    },
  );
  const visibleActions = () =>
    (
      [
        ["install", "chromeExtensionSetup"],
        ["inspect", "chromeExtensionRefresh"],
        ["verify", "chromeExtensionVerify"],
      ] as const
    ).filter(
      ([action]) =>
        actions().includes(action) &&
        (action !== "install" || !props.autoInspect || needsInstall()),
    );
  return (
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
  );
}

defineSolidBridge<Props>("openclaw-native-chrome-setup", NativeChromeSetupContent, {
  properties: { autoInspect: { default: false, attribute: "auto-inspect" } },
  disconnected: (host) => resetOnDisconnect.get(host)?.(),
});
