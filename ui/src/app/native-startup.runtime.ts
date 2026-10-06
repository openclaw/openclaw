import type { ApplicationContext } from "./context.ts";
import type { NativeConversationBridge } from "./native-conversation-types.ts";
import type { NativeDeviceSettingsCapability } from "./native-device-settings.ts";
import type { NativeNotificationsCapability } from "./native-notifications.ts";
import { nativeEmbedHost } from "./native-web-chrome.ts";
import type { createStartupLifecycle, StartupStep } from "./startup-lifecycle.ts";

type NativeCapabilities = {
  conversation: NativeConversationBridge | null;
  deviceSettings: NativeDeviceSettingsCapability | null;
  notifications: NativeNotificationsCapability | null;
};

export async function startNativeCapabilities(
  context: ApplicationContext,
  lifecycle: ReturnType<typeof createStartupLifecycle>,
  update: (capabilities: NativeCapabilities) => void,
): Promise<void> {
  // SAFETY: WebKit supplies these optional handlers; every callable is checked before initialization.
  const nativeWindow = window as Window & {
    webkit?: {
      messageHandlers?: {
        openclawDeviceSettings?: { postMessage?: unknown };
        openclawNotifications?: { postMessage?: unknown };
        openclawGateways?: { postMessage?: unknown };
      };
    };
  };
  const gateway = context.gateway;
  const handlers = nativeWindow.webkit?.messageHandlers;
  const capabilities: NativeCapabilities = {
    conversation: null,
    deviceSettings: null,
    notifications: null,
  };
  const steps: StartupStep[] = [];
  if (nativeEmbedHost()?.surface === "conversation") {
    steps.push(async () => {
      const { createNativeConversationBridge } = await import("./native-conversation-bridge.ts");
      if (!lifecycle.signal.aborted) {
        capabilities.conversation = createNativeConversationBridge(context);
        update(capabilities);
        return () => capabilities.conversation?.dispose();
      }
      return undefined;
    });
  }
  if (typeof handlers?.openclawDeviceSettings?.postMessage === "function") {
    steps.push(async () => {
      const { createNativeDeviceSettingsCapability } = await import("./native-device-settings.ts");
      if (!lifecycle.signal.aborted) {
        capabilities.deviceSettings = createNativeDeviceSettingsCapability();
        update(capabilities);
        return () => capabilities.deviceSettings?.dispose();
      }
      return undefined;
    });
  }
  if (typeof handlers?.openclawNotifications?.postMessage === "function") {
    steps.push(async () => {
      const { createNativeNotificationsCapability } = await import("./native-notifications.ts");
      if (!lifecycle.signal.aborted) {
        capabilities.notifications = createNativeNotificationsCapability();
        update(capabilities);
        return () => capabilities.notifications?.dispose();
      }
      return undefined;
    });
  }
  if (typeof handlers?.openclawGateways?.postMessage === "function") {
    steps.push(async () => {
      const { startNativeGatewayHealthReporting } =
        await import("./native-gateway-health.runtime.ts");
      if (!lifecycle.signal.aborted) {
        return startNativeGatewayHealthReporting(gateway);
      }
      return undefined;
    });
  }
  await lifecycle.run(steps);
}
