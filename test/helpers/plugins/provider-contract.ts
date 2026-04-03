import { describe, expect, it } from "vitest";
import {
  providerContractLoadError,
  resolveProviderContractProvidersForPluginIds,
} from "../../../src/plugins/contracts/registry.js";
import { installProviderPluginContractSuite } from "./provider-contract-suites.js";

export function describeProviderContracts(pluginId: string) {
  const providers = resolveProviderContractProvidersForPluginIds([pluginId]);

  describe(`${pluginId} provider contract registry load`, () => {
    it("loads bundled providers without import-time registry failure", () => {
      expect(providerContractLoadError).toBeUndefined();
      expect(providers.length).toBeGreaterThan(0);
    });
  });

  for (const provider of providers) {
    describe(`${pluginId}:${provider.id} provider contract`, () => {
      installProviderPluginContractSuite({ provider });
    });
  }
}
