/**
 * Contract suite for bundled web fetch provider registration and runtime behavior.
 */
import { describe, expect, it } from "vitest";
import {
  getPluginRegistrationContracts,
  resolveWebFetchProviderContractEntriesForPluginId,
} from "../../plugins/contracts/registry.js";
import { installWebFetchProviderContractSuite } from "./provider-contract-suites.js";

/** Installs web fetch provider contract tests for all providers owned by one plugin. */
export function describeWebFetchProviderContracts(pluginId: string) {
  const providerIds =
    getPluginRegistrationContracts().find((entry) => entry.pluginId === pluginId)
      ?.webFetchProviderIds ?? [];

  let providerEntries:
    | ReturnType<typeof resolveWebFetchProviderContractEntriesForPluginId>
    | undefined;
  const resolveProviders = () =>
    (providerEntries ??= resolveWebFetchProviderContractEntriesForPluginId(pluginId));

  describe(`${pluginId} web fetch provider contract registry load`, () => {
    it("loads bundled web fetch providers", () => {
      expect(resolveProviders().length).toBeGreaterThan(0);
    });
  });

  for (const providerId of providerIds) {
    describe(`${pluginId}:${providerId} web fetch contract`, () => {
      const resolveEntry = () => {
        const entry = resolveProviders().find((candidate) => candidate.provider.id === providerId);
        if (!entry) {
          throw new Error(
            `web fetch provider contract entry missing for ${pluginId}:${providerId}`,
          );
        }
        return entry;
      };
      installWebFetchProviderContractSuite({
        provider: () => resolveEntry().provider,
        credentialValue: () => resolveEntry().credentialValue,
        pluginId,
      });
    });
  }
}
