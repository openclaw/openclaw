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
      if (providerIds.length === 0) {
        throw new Error(`expected provider contract metadata for plugin ${pluginId}`);
      }
      const providers = resolveProviderContractProvidersForPluginIds([pluginId]);
      if (providers.length > 0) {
        expect(providerContractLoadError).toBeUndefined();
      }
      expect(providerIds.length).toBeGreaterThan(0);
    });
  });

  if (process.env.VITEST) {
    return;
  }

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
