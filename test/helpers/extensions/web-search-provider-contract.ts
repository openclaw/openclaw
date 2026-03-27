import { describe, expect, it } from "vitest";
import { webSearchProviderContractRegistry } from "../../../src/plugins/contracts/registry.js";
import { installWebSearchProviderContractSuite } from "../../../src/plugins/contracts/suites.js";

export function describeWebSearchProviderContracts(pluginId: string) {
  const providers = webSearchProviderContractRegistry.filter(
    (entry) => entry.pluginId === pluginId,
  );

  describe(`${pluginId} web search provider contract registry load`, () => {
    it("loads bundled web search providers", () => {
      expect(providers.length).toBeGreaterThan(0);
    });
  });

  for (const entry of providers) {
    describe(`${pluginId}:${entry.provider.id} web search contract`, () => {
      installWebSearchProviderContractSuite({
        provider: entry.provider,
        credentialValue: entry.credentialValue,
      });
    });
  }
}
