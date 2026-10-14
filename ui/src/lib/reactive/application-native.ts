import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import type { NativeNotificationsCapability } from "../../app/native-notifications.ts";
import { projectOwner } from "./projection.ts";

export function projectNativeDeviceSettings(source: NativeDeviceSettingsCapability) {
  return projectOwner(source, (settings) => settings.snapshot);
}

export function projectNativeNotifications(source: NativeNotificationsCapability) {
  return projectOwner(source, (notifications) => notifications.snapshot);
}
