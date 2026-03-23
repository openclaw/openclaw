import { resolveProviderPluginChoice } from "../../../plugins/provider-wizard.js";
import { resolveOwningPluginIdsForProvider } from "../../../plugins/providers.js";
import { resolvePluginProviders } from "../../../plugins/providers.runtime.js";

export const authChoicePluginProvidersRuntime = {
  resolveOwningPluginIdsForProvider,
  resolveProviderPluginChoice,
  resolvePluginProviders,
};
