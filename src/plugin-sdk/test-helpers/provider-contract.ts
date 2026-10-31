// Provider contract helpers expose reusable provider plugin contract test setup.
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it } from "vitest";
import { resolveProviderContractEntriesForPluginId } from "../../plugins/contracts/registry.js";
import type { ProviderPlugin } from "../provider-model-shared.js";
import { installProviderPluginContractSuite } from "./provider-contract-suites.js";

function providerMatchesManifestId(provider: ProviderPlugin, providerId: string): boolean {
  return (
    provider.id === providerId ||
    (provider.aliases ?? []).includes(providerId) ||
    (provider.hookAliases ?? []).includes(providerId)
  );
}

export function describeProviderContracts(pluginId: string) {
  let providers: ProviderPlugin[] = [];
  let loadError: Error | undefined;
  try {
    providers = resolveProviderContractEntriesForPluginId(pluginId).map((entry) => entry.provider);
  } catch (error) {
    loadError = toErrorObject(error, `provider contract load failed for ${pluginId}`);
  }

  describe(`${pluginId} provider contract registry load`, () => {
    it("loads bundled providers without import-time registry failure", () => {
      expect(loadError).toBeUndefined();
      expect(providers.length).toBeGreaterThan(0);
    });
  });

  for (const { id: providerId } of providers) {
    describe(`${pluginId}:${providerId} provider contract`, () => {
      installProviderPluginContractSuite({
        provider: () => {
          const provider = providers.find((entry) => providerMatchesManifestId(entry, providerId));
          if (!provider) {
            throw new Error(`provider contract entry missing for ${pluginId}:${providerId}`);
          }
          return provider;
        },
      });
    });
  }
}
