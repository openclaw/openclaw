import { describe } from "vitest";
import { providerContractRegistry } from "./registry.js";
import { installProviderPluginContractSuite } from "./suites.js";

for (const entry of providerContractRegistry) {
  describe(`${entry.pluginId}:${entry.provider.id} provider contract`, () => {
    installProviderPluginContractSuite({
      provider: entry.provider,
    });
  });
}
