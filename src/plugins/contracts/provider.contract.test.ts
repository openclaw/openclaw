import { describeProviderContracts } from "../../../test/helpers/plugins/provider-contract.js";
import { pluginRegistrationContractRegistry } from "./registry.js";

const providerContractTests = pluginRegistrationContractRegistry.filter(
  (entry) => entry.providerIds.length > 0,
);

for (const entry of providerContractTests) {
  describeProviderContracts(entry.pluginId);
}
