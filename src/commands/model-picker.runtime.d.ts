import { resolveProviderModelPickerFlowContributions, resolveProviderModelPickerFlowEntries } from "../flows/provider-flow.js";
import { runProviderPluginAuthMethod } from "../plugins/provider-auth-choice.js";
import { resolveProviderPluginChoice, runProviderModelSelectedHook } from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
export declare const modelPickerRuntime: {
    resolveProviderModelPickerContributions: typeof resolveProviderModelPickerFlowContributions;
    resolveProviderModelPickerEntries: typeof resolveProviderModelPickerFlowEntries;
    resolveProviderPluginChoice: typeof resolveProviderPluginChoice;
    runProviderModelSelectedHook: typeof runProviderModelSelectedHook;
    resolvePluginProviders: typeof resolvePluginProviders;
    runProviderPluginAuthMethod: typeof runProviderPluginAuthMethod;
};
