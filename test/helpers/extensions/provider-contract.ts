import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  providerContractLoadError,
  requireProviderContractProvider,
  resolveProviderContractProvidersForPluginIds,
} from "../../../src/plugins/contracts/registry.js";
import { installProviderPluginContractSuite } from "../../../src/plugins/contracts/suites.js";

export function describeProviderContracts(pluginId: string) {
  const providerIds =
    pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)?.providerIds ??
    [];

  describe(`${pluginId} provider contract registry load`, () => {
    it("loads bundled providers without import-time registry failure", () => {
      const providers = resolveProviderContractProvidersForPluginIds([pluginId]);
      expect(providerContractLoadError).toBeUndefined();
      expect(providers.length).toBeGreaterThan(0);
    });
  });

  for (const providerId of providerIds) {
    describe(`${pluginId}:${providerId} provider contract`, () => {
      // Resolve provider entries lazily so the non-isolated extension runner
      // does not race provider contract collection against other file imports.
      installProviderPluginContractSuite({
        provider: () => requireProviderContractProvider(providerId),
      });
    });
  }
}
