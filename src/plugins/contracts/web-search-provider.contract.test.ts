import { describeWebSearchProviderContracts } from "../../../test/helpers/plugins/web-search-provider-contract.js";
import { pluginRegistrationContractRegistry } from "./registry.js";

const webSearchProviderContractTests = pluginRegistrationContractRegistry.filter(
  (entry) => entry.webSearchProviderIds.length > 0,
);

for (const entry of webSearchProviderContractTests) {
  describeWebSearchProviderContracts(entry.pluginId);
}
