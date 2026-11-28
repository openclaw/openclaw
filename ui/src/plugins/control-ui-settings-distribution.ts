import type { PluginManifestControlUiSettingsView } from "../../../src/plugins/manifest-types.ts";
import type { ControlUiPluginDistribution } from "./control-ui-distribution.ts";

export type ControlUiSettingsDistribution = Pick<
  ControlUiPluginDistribution,
  "pluginId" | "entry" | "styles"
> & {
  settingsViews: readonly PluginManifestControlUiSettingsView[];
};

// The Vite adapter adds the packaged row declarations only to Settings consumers.
export const controlUiSettingsDistributions: readonly ControlUiSettingsDistribution[] = [];
