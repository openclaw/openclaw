import type { PluginControlUiEntryPoint } from "./host-hooks.js";

export type PluginControlUiEntryPointRegistryRegistration = {
  entryPoint: PluginControlUiEntryPoint;
  pluginId: string;
  pluginName?: string;
  rootDir?: string;
  source: string;
};
