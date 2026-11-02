import type { PluginControlUiModule } from "../../../packages/gateway-protocol/src/schema/plugins.js";

export type ControlUiPluginDistribution = Pick<
  PluginControlUiModule,
  "pluginId" | "revision" | "bundledDistribution"
> & {
  entry: string;
  styles: string[];
  imports: string[];
  activation?: "settings-only";
  settingsViews?: readonly import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiSettingsPlacement[];
};

// The production Vite adapter replaces this module with its emitted asset inventory.
// A standalone UI without packaged plugin artifacts keeps the Gateway delivery route.
export const controlUiPluginDistributions: readonly ControlUiPluginDistribution[] = [];
