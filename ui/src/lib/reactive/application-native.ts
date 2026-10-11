import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { projectSource } from "./projection.ts";

export function projectNativeDeviceSettings(source: NativeDeviceSettingsCapability) {
  return projectSource(source, {
    read: (settings) => settings.snapshot,
    subscribe: (settings, notify) => settings.subscribe(notify),
    equality: "revision",
  });
}
