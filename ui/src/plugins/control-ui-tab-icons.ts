import type { ControlUiTabIconAccessory } from "../../../src/plugin-sdk/control-ui.js";
import type { ControlUiPluginCapability, ControlUiRegistration } from "./control-ui-capability.ts";

export function tabIconContributions(
  plugins: ControlUiPluginCapability | undefined,
): ControlUiRegistration<ControlUiTabIconAccessory>[] {
  return (
    plugins
      ?.registrations("accessories")
      .filter(
        (entry): entry is ControlUiRegistration<ControlUiTabIconAccessory> =>
          entry.value.placement === "tab-icon",
      ) ?? []
  );
}
