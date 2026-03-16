import { describe } from "vitest";
import { webSearchProviderContractRegistry } from "./registry.js";
import { installWebSearchProviderContractSuite } from "./suites.js";

for (const entry of webSearchProviderContractRegistry) {
  describe(`${entry.pluginId}:${entry.provider.id} web search contract`, () => {
    installWebSearchProviderContractSuite({
      provider: entry.provider,
      credentialValue: entry.credentialValue,
    });
  });
}
