import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import type { NativeNotificationsCapability } from "../../app/native-notifications.ts";
import { projectSource } from "./projection.ts";

export function projectNativeDeviceSettings(source: NativeDeviceSettingsCapability) {
  return projectSource(source, {
    read: (settings) => settings.snapshot,
    subscribe: (settings, notify) => settings.subscribe(notify),
    equality: "revision",
  });
}

export function projectNativeNotifications(source: NativeNotificationsCapability) {
  return projectSource(source, {
    read: (notifications) => notifications.snapshot,
    subscribe: (notifications, notify) => notifications.subscribe(notify),
    equality: "revision",
  });
}
