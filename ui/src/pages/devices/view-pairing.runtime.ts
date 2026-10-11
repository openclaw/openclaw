import { solidContent } from "../../lit/solid-content.tsx";
import { DevicePairSetup, type DevicePairSetupProps } from "./view-pairing.tsx";

/** The unported shell loads this modal lazily and retains its Solid root across updates. */
export function renderDevicePairSetup(props: DevicePairSetupProps) {
  return solidContent(DevicePairSetup, props);
}
