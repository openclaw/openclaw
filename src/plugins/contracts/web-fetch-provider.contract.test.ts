// Web fetch provider contract tests cover plugin web-fetch provider behavior.
import { describeWebFetchProviderContracts } from "../../plugin-sdk/test-helpers/web-fetch-provider-contract.js";
import { getPluginRegistrationContracts } from "./registry.js";

const webFetchProviderContractTests = getPluginRegistrationContracts().filter(
  (entry) => entry.webFetchProviderIds.length > 0,
);

for (const entry of webFetchProviderContractTests) {
  describeWebFetchProviderContracts(entry.pluginId);
}
