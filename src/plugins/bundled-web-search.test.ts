import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import { BUNDLED_WEB_SEARCH_PLUGIN_IDS } from "./bundled-web-search-ids.js";
import { resolveBundledWebSearchPluginId } from "./bundled-web-search-provider-ids.js";
import {
  listBundledWebSearchProviders,
  resolveBundledWebSearchPluginIds,
} from "./bundled-web-search.js";

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
      "searxng",
      "tavily",
      "xai",
    ]);
  });

  it("keeps bundled web search fast-path ids aligned with the registry", () => {
    expect([...BUNDLED_WEB_SEARCH_PLUGIN_IDS]).toEqual(
      listBundledWebSearchProviders()
        .map(({ pluginId }) => pluginId)
        .filter((value, index, values) => values.indexOf(value) === index)
        .toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it("keeps bundled web search provider-to-plugin ids aligned with bundled contracts", () => {
    expect(resolveBundledWebSearchPluginId("brave")).toBe("brave");
    expect(resolveBundledWebSearchPluginId("duckduckgo")).toBe("duckduckgo");
    expect(resolveBundledWebSearchPluginId("exa")).toBe("exa");
    expect(resolveBundledWebSearchPluginId("firecrawl")).toBe("firecrawl");
    expect(resolveBundledWebSearchPluginId("gemini")).toBe("google");
    expect(resolveBundledWebSearchPluginId("kimi")).toBe("moonshot");
    expect(resolveBundledWebSearchPluginId("perplexity")).toBe("perplexity");
    expect(resolveBundledWebSearchPluginId("tavily")).toBe("tavily");
    expect(resolveBundledWebSearchPluginId("grok")).toBe("xai");
  });

  it("keeps bundled provider metadata aligned with bundled plugin contracts", async () => {
    const fastPathProviders = listBundledWebSearchProviders();
    const bundledProviderEntries = loadBundledCapabilityRuntimeRegistry({
      pluginIds: BUNDLED_WEB_SEARCH_PLUGIN_IDS,
      pluginSdkResolution: "dist",
    }).webSearchProviders.map((entry) => ({
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
        bundledProviderEntries.map(({ pluginId, ...provider }) =>
          toComparableEntry({
            pluginId,
            provider,
          }),
        ),
      ),
    );

    for (const fastPathProvider of fastPathProviders) {
      const bundledEntry = bundledProviderEntries.find(
        (entry) => entry.pluginId === fastPathProvider.pluginId && entry.id === fastPathProvider.id,
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
