/**
 * Contract suite for bundled web fetch provider registration and runtime behavior.
 */
import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  resolveWebFetchProviderContractEntriesForPluginId,
} from "../../plugins/contracts/registry.js";
import { resolveBundledExplicitWebFetchProvidersFromPublicArtifacts } from "../../plugins/web-provider-public-artifacts.explicit.js";
import type { WebFetchProviderPlugin } from "../provider-web-fetch-contract.js";
import { installWebFetchProviderContractSuite } from "./provider-contract-suites.js";

function resolveWebFetchCredentialValue(provider: WebFetchProviderPlugin): unknown {
  if (provider.requiresCredential === false) {
    return `${provider.id}-no-key-needed`;
  }
  const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
  if (!envVar) {
    return `${provider.id}-test`;
  }
  return envVar.toLowerCase().includes("api_key") ? `${provider.id}-test` : "sk-test";
}

/** Installs web fetch provider contract tests for all providers owned by one plugin. */
export function describeWebFetchProviderContracts(pluginId: string) {
  const providerIds =
    pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)
      ?.webFetchProviderIds ?? [];

  let providerEntries:
    | Array<{
        pluginId: string;
        provider: WebFetchProviderPlugin;
        credentialValue: unknown;
      }>
    | undefined;
  const resolveProviders = () =>
    (providerEntries ??=
      resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({
        onlyPluginIds: [pluginId],
      })?.map((provider) => ({
        pluginId: provider.pluginId,
        provider,
        credentialValue: resolveWebFetchCredentialValue(provider),
      })) ?? resolveWebFetchProviderContractEntriesForPluginId(pluginId));

  describe(`${pluginId} web fetch provider contract registry load`, () => {
    it("loads bundled web fetch providers", () => {
      expect(resolveProviders().length).toBeGreaterThan(0);
    });
  });

  for (const providerId of providerIds) {
    describe(`${pluginId}:${providerId} web fetch contract`, () => {
      const resolveEntry = () => {
        const entry = resolveProviders().find((entry) => entry.provider.id === providerId);
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
