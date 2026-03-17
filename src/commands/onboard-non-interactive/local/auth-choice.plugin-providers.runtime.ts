import { resolveProviderPluginChoice } from "../../../plugins/provider-wizard.js";
import {
  resolveOwningPluginIdsForProvider,
  resolvePluginProviders,
} from "../../../plugins/providers.js";

export const authChoicePluginProvidersRuntime = {
  resolveOwningPluginIdsForProvider,
  resolveProviderPluginChoice,
  resolvePluginProviders,
};
