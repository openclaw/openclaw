import { t } from "../i18n/index.ts";
import type { ApplicationContext } from "./context.ts";
import { nativeGatewaysCapability } from "./native-gateways.runtime.ts";

/** Shell-owned setup actions. Hosts install this capability before the Control UI boots. */
export type NativeSetupCapability = {
  /** Display label supplied by the shell, including its local-device name. */
  readonly currentGateway?: { name: string; kind: "local" | "remote" };
  openAiSetup?: () => void;
  openGateways?: () => void;
  reviewPermissions?: () => void;
};

declare global {
  interface Window {
    __OPENCLAW_NATIVE_SETUP__?: NativeSetupCapability;
  }
}

export function nativeSetupCapability(context: ApplicationContext): NativeSetupCapability | null {
  // Tauri and other shells supply actions directly; cards never depend on a transport.
  const supplied = typeof window === "undefined" ? undefined : window["__OPENCLAW_NATIVE_SETUP__"];
  if (supplied) {
    return supplied;
  }
  const settings = context.nativeDeviceSettings;
  const gateways = nativeGatewaysCapability();
  if (!settings && !gateways) {
    return null;
  }
  const snapshot = gateways?.snapshot;
  const current = snapshot?.gateways.find((entry) => entry.id === snapshot.currentId);
  return {
    currentGateway: current
      ? {
          name: current.kind === "local" ? t("custodian.autoSetup.thisMac") : current.name,
          kind: current.kind,
        }
      : undefined,
    openAiSetup: settings ? () => settings.openPanel("ai-setup") : undefined,
    openGateways: gateways ? () => gateways.openSettings() : undefined,
    reviewPermissions: settings ? () => context.navigate("device-permissions") : undefined,
  };
}
