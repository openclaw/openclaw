import { describe, expect, it } from "vitest";
import { bundledWebSearchPluginRegistrations } from "../bundled-web-search-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { BUNDLED_WEB_SEARCH_PLUGIN_IDS } from "./bundled-web-search-ids.js";
import {
  listBundledWebSearchProviders,
  resolveBundledWebSearchPluginIds,
} from "./bundled-web-search.js";
import { webSearchProviderContractRegistry } from "./contracts/registry.js";

describe("bundled web search metadata", () => {
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
  }) {
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

  function sortComparableEntries<
    T extends {
      autoDetectOrder?: number;
      id: string;
      pluginId: string;
    },
  >(entries: T[]): T[] {
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

  it("keeps bundled web search compat ids aligned with bundled manifests", () => {
    expect(resolveBundledWebSearchPluginIds({})).toEqual([
      "brave",
      "duckduckgo",
      "exa",
      "firecrawl",
      "google",
      "moonshot",
      "perplexity",
      "tavily",
      "xai",
    ]);
  });

  it("keeps bundled web search fast-path ids aligned with the registry", () => {
    expect([...BUNDLED_WEB_SEARCH_PLUGIN_IDS]).toEqual(
      bundledWebSearchPluginRegistrations
        .map(({ plugin }) => plugin.id)
        .toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it("keeps fast-path bundled provider metadata aligned with bundled plugin contracts", async () => {
    const fastPathProviders = listBundledWebSearchProviders();

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
        webSearchProviderContractRegistry.map(({ pluginId, provider }) =>
          toComparableEntry({
            pluginId,
            provider,
          }),
        ),
      ),
    );

    for (const fastPathProvider of fastPathProviders) {
      const contractEntry = webSearchProviderContractRegistry.find(
        (entry) =>
          entry.pluginId === fastPathProvider.pluginId && entry.provider.id === fastPathProvider.id,
      );
      expect(contractEntry).toBeDefined();
      const contractProvider = contractEntry!.provider;

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
