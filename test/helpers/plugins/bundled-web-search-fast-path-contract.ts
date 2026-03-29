import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { loadBundledCapabilityRuntimeRegistry } from "../../../src/plugins/bundled-capability-runtime.js";
import { BUNDLED_WEB_SEARCH_PLUGIN_IDS } from "../../../src/plugins/bundled-web-search-ids.js";
import { resolveBundledWebSearchPluginId } from "../../../src/plugins/bundled-web-search-provider-ids.js";
import { listBundledWebSearchProviders } from "../../../src/plugins/bundled-web-search.js";

type ComparableProvider = {
  pluginId: string;
  id: string;
  label: string;
  hint: string;
  envVars: string[];
  placeholder: string;
  signupUrl: string;
  docsUrl?: string;
  autoDetectOrder?: number;
  requiresCredential?: boolean;
  credentialPath: string;
  inactiveSecretPaths?: string[];
  hasConfiguredCredentialAccessors: boolean;
  hasApplySelectionConfig: boolean;
  hasResolveRuntimeMetadata: boolean;
};

function toComparableEntry(params: {
  pluginId: string;
  provider: {
    id: string;
    label: string;
    hint: string;
    envVars: string[];
    placeholder: string;
    signupUrl: string;
    docsUrl?: string;
    autoDetectOrder?: number;
    requiresCredential?: boolean;
    credentialPath: string;
    inactiveSecretPaths?: string[];
    getConfiguredCredentialValue?: unknown;
    setConfiguredCredentialValue?: unknown;
    applySelectionConfig?: unknown;
    resolveRuntimeMetadata?: unknown;
  };
}): ComparableProvider {
  return {
    pluginId: params.pluginId,
    id: params.provider.id,
    label: params.provider.label,
    hint: params.provider.hint,
    envVars: params.provider.envVars,
    placeholder: params.provider.placeholder,
    signupUrl: params.provider.signupUrl,
    docsUrl: params.provider.docsUrl,
    autoDetectOrder: params.provider.autoDetectOrder,
    requiresCredential: params.provider.requiresCredential,
    credentialPath: params.provider.credentialPath,
    inactiveSecretPaths: params.provider.inactiveSecretPaths,
    hasConfiguredCredentialAccessors:
      typeof params.provider.getConfiguredCredentialValue === "function" &&
      typeof params.provider.setConfiguredCredentialValue === "function",
    hasApplySelectionConfig: typeof params.provider.applySelectionConfig === "function",
    hasResolveRuntimeMetadata: typeof params.provider.resolveRuntimeMetadata === "function",
  };
}

function sortComparableEntries(entries: ComparableProvider[]): ComparableProvider[] {
  return [...entries].toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    return (
      leftOrder - rightOrder ||
      left.id.localeCompare(right.id) ||
      left.pluginId.localeCompare(right.pluginId)
    );
  });
}

export function describeBundledWebSearchFastPathContract(pluginId: string) {
  describe(`${pluginId} bundled web search fast-path contract`, () => {
    it("keeps provider-to-plugin ids aligned with bundled contracts", () => {
      const providers = listBundledWebSearchProviders().filter(
        (provider) => provider.pluginId === pluginId,
      );
      expect(providers.length).toBeGreaterThan(0);
      for (const provider of providers) {
        expect(resolveBundledWebSearchPluginId(provider.id)).toBe(pluginId);
      }
    });

    it("keeps fast-path provider metadata aligned with the bundled runtime registry", async () => {
      const fastPathProviders = listBundledWebSearchProviders().filter(
        (provider) => provider.pluginId === pluginId,
      );
      const bundledProviderEntries = loadBundledCapabilityRuntimeRegistry({
        pluginIds: BUNDLED_WEB_SEARCH_PLUGIN_IDS,
        pluginSdkResolution: "dist",
      })
        .webSearchProviders.filter((entry) => entry.pluginId === pluginId)
        .map((entry) => ({
          pluginId: entry.pluginId,
          ...entry.provider,
        }));

      expect(
        sortComparableEntries(
          fastPathProviders.map((provider) =>
            toComparableEntry({
              pluginId: provider.pluginId,
              provider,
            }),
          ),
        ),
      ).toEqual(
        sortComparableEntries(
          bundledProviderEntries.map(({ pluginId: entryPluginId, ...provider }) =>
            toComparableEntry({
              pluginId: entryPluginId,
              provider,
            }),
          ),
        ),
      );

      for (const fastPathProvider of fastPathProviders) {
        const bundledEntry = bundledProviderEntries.find(
          (entry) => entry.id === fastPathProvider.id,
        );
        expect(bundledEntry).toBeDefined();
        const contractProvider = bundledEntry!;

        const fastSearchConfig: Record<string, unknown> = {};
        const contractSearchConfig: Record<string, unknown> = {};
        fastPathProvider.setCredentialValue(fastSearchConfig, "test-key");
        contractProvider.setCredentialValue(contractSearchConfig, "test-key");
        expect(fastSearchConfig).toEqual(contractSearchConfig);
        expect(fastPathProvider.getCredentialValue(fastSearchConfig)).toEqual(
          contractProvider.getCredentialValue(contractSearchConfig),
        );

        const fastConfig = {} as OpenClawConfig;
        const contractConfig = {} as OpenClawConfig;
        fastPathProvider.setConfiguredCredentialValue?.(fastConfig, "test-key");
        contractProvider.setConfiguredCredentialValue?.(contractConfig, "test-key");
        expect(fastConfig).toEqual(contractConfig);
        expect(fastPathProvider.getConfiguredCredentialValue?.(fastConfig)).toEqual(
          contractProvider.getConfiguredCredentialValue?.(contractConfig),
        );

        if (fastPathProvider.applySelectionConfig || contractProvider.applySelectionConfig) {
          expect(fastPathProvider.applySelectionConfig?.({} as OpenClawConfig)).toEqual(
            contractProvider.applySelectionConfig?.({} as OpenClawConfig),
          );
        }

        if (fastPathProvider.resolveRuntimeMetadata || contractProvider.resolveRuntimeMetadata) {
          const metadataCases = [
            {
              searchConfig: fastSearchConfig,
              resolvedCredential: {
                value: "pplx-test",
                source: "secretRef" as const,
                fallbackEnvVar: undefined,
              },
            },
            {
              searchConfig: fastSearchConfig,
              resolvedCredential: {
                value: undefined,
                source: "env" as const,
                fallbackEnvVar: "OPENROUTER_API_KEY",
              },
            },
            {
              searchConfig: {
                ...fastSearchConfig,
                perplexity: {
                  ...(fastSearchConfig.perplexity as Record<string, unknown> | undefined),
                  model: "custom-model",
                },
              },
              resolvedCredential: {
                value: "pplx-test",
                source: "secretRef" as const,
                fallbackEnvVar: undefined,
              },
            },
          ];

          for (const testCase of metadataCases) {
            expect(
              await fastPathProvider.resolveRuntimeMetadata?.({
                config: fastConfig,
                searchConfig: testCase.searchConfig,
                runtimeMetadata: {
                  diagnostics: [],
                  providerSource: "configured",
                },
                resolvedCredential: testCase.resolvedCredential,
              }),
            ).toEqual(
              await contractProvider.resolveRuntimeMetadata?.({
                config: contractConfig,
                searchConfig: testCase.searchConfig,
                runtimeMetadata: {
                  diagnostics: [],
                  providerSource: "configured",
                },
                resolvedCredential: testCase.resolvedCredential,
              }),
            );
          }
        }
      }
    });
  });
}
