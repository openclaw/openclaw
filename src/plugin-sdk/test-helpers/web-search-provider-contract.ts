/**
 * Contract suite for bundled web search provider registration and runtime behavior.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  getPluginRegistrationContracts,
  resolveWebSearchProviderContractEntriesForPluginId,
} from "../../plugins/contracts/registry.js";
import { installWebSearchProviderContractSuite } from "./provider-contract-suites.js";

type WebSearchContractEntry = ReturnType<
  typeof resolveWebSearchProviderContractEntriesForPluginId
>[number];

export function describeWebSearchProviderContracts(pluginId: string) {
  const providerIds =
    getPluginRegistrationContracts().find((entry) => entry.pluginId === pluginId)
      ?.webSearchProviderIds ?? [];

  let providerEntries: WebSearchContractEntry[] | undefined;
  const resolveProviders = (): WebSearchContractEntry[] =>
    (providerEntries ??= resolveWebSearchProviderContractEntriesForPluginId(pluginId));

  describe(`${pluginId} web search provider contract registry load`, () => {
    beforeAll(() => {
      // Public-artifact loading is suite setup shared by every provider
      // assertion; keep its cold module cost out of an arbitrary first test.
      resolveProviders();
    });

    it("loads bundled web search providers", () => {
      expect(resolveProviders().length).toBeGreaterThan(0);
    });
  });

  for (const providerId of providerIds) {
    describe(`${pluginId}:${providerId} web search contract`, () => {
      const resolveEntry = () => {
        const entry = resolveProviders().find((candidate) => candidate.provider.id === providerId);
        if (!entry) {
          throw new Error(
            `web search provider contract entry missing for ${pluginId}:${providerId}`,
          );
        }
        return entry;
      };
      installWebSearchProviderContractSuite({
        provider: () => resolveEntry().provider,
        credentialValue: () => resolveEntry().credentialValue,
      });
    });
  }
}
