import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { projectOwner } from "./projection.ts";

export function projectNativeDeviceSettings(source: NativeDeviceSettingsCapability) {
  return projectOwner(source, (settings) => settings.snapshot);
}
