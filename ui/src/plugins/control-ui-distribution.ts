import type { PluginControlUiModule } from "../../../packages/gateway-protocol/src/schema/plugins.js";

export type ControlUiPluginDistribution = Pick<
  PluginControlUiModule,
  "pluginId" | "name" | "revision" | "bundledDistribution"
> & {
  entry: string;
  styles: string[];
  imports: string[];
  activation?: "settings-only";
  /** Settings placements, each with the setting IDs its view draws. */
  settingsViews?: readonly import("../../../src/plugins/manifest-types.js").PluginManifestControlUiSettingsView[];
};

// The production Vite adapter replaces this module with its emitted asset inventory.
// A standalone UI without packaged plugin artifacts keeps the Gateway delivery route.
export const controlUiPluginDistributions: readonly ControlUiPluginDistribution[] = [];
