import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  resolveWebFetchProviderContractEntriesForPluginId,
} from "../../../src/plugins/contracts/registry.js";
import { installWebFetchProviderContractSuite } from "./provider-contract-suites.js";

export function describeWebFetchProviderContracts(pluginId: string) {
  const providerIds =
    pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)
      ?.webFetchProviderIds ?? [];

  const resolveProviders = () => resolveWebFetchProviderContractEntriesForPluginId(pluginId);

  describe(`${pluginId} web fetch provider contract registry load`, () => {
    it("loads bundled web fetch providers", () => {
      expect(resolveProviders().length).toBeGreaterThan(0);
    });
  });

  for (const providerId of providerIds) {
    describe(`${pluginId}:${providerId} web fetch contract`, () => {
      installWebFetchProviderContractSuite({
        provider: () => {
          const entry = resolveProviders().find((provider) => provider.provider.id === providerId);
          if (!entry) {
            throw new Error(
              `web fetch provider contract entry missing for ${pluginId}:${providerId}`,
            );
          }
          return entry.provider;
        },
        credentialValue: () => {
          const entry = resolveProviders().find((provider) => provider.provider.id === providerId);
          if (!entry) {
            throw new Error(
              `web fetch provider contract entry missing for ${pluginId}:${providerId}`,
            );
          }
          return entry.credentialValue;
        },
        pluginId,
      });
    });
  }
}
