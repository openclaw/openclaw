import {
  resolveProviderModelPickerFlowContributions,
  resolveProviderModelPickerFlowEntries,
} from "../flows/provider-flow.runtime.js";
import { runProviderPluginAuthMethod } from "../plugins/provider-auth-choice.js";
import {
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
} from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";

/** Lazy runtime bundle used by model picker flows and mocked as one unit in tests. */
export const modelPickerRuntime = {
  resolveProviderModelPickerContributions: resolveProviderModelPickerFlowContributions,
  resolveProviderModelPickerEntries: resolveProviderModelPickerFlowEntries,
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
  resolvePluginProviders,
  runProviderPluginAuthMethod,
};
