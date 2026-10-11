/** Runtime dependency bundle for provider/model picker flows. */
import { runProviderPluginAuthMethod } from "../plugins/provider-auth-choice.js";
import {
  resolveProviderPluginChoiceCore,
  resolveProviderModelPickerEntries,
  runProviderModelSelectedHookCore,
} from "../plugins/provider-wizard.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";

/** Lazy runtime methods consumed by model picker command flows. */
export const modelPickerRuntime = {
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoice: resolveProviderPluginChoiceCore,
  runProviderModelSelectedHook: runProviderModelSelectedHookCore,
  resolvePluginProviders: resolvePluginProvidersCore,
  runProviderPluginAuthMethod,
};
