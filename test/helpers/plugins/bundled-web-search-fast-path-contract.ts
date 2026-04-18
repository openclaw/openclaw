import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { resolveBundledPluginsDir } from "../../../src/plugins/bundled-dir.js";
import {
  resolveBundledExplicitRuntimeWebSearchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "../../../src/plugins/web-provider-public-artifacts.explicit.js";
import { normalizeOptionalLowercaseString } from "../../../src/shared/string-coerce.js";

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

type MinimalBundledPluginManifest = {
  id?: unknown;
  contracts?: {
    webSearchProviders?: unknown;
  };
};

const bundledWebSearchManifestContracts = new Map<
  string,
  { pluginId: string; webSearchProviderIds: string[] } | null
>();

function readBundledWebSearchManifestContract(pluginId: string) {
  if (bundledWebSearchManifestContracts.has(pluginId)) {
    return bundledWebSearchManifestContracts.get(pluginId) ?? null;
  }

  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    bundledWebSearchManifestContracts.set(pluginId, null);
    return null;
  }

  const manifestPath = path.join(bundledPluginsDir, pluginId, "openclaw.plugin.json");
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as MinimalBundledPluginManifest;
  const manifestPluginId = typeof manifest.id === "string" ? manifest.id : "";
  const webSearchProviderIds = Array.isArray(manifest.contracts?.webSearchProviders)
    ? manifest.contracts.webSearchProviders.filter(
        (providerId): providerId is string => typeof providerId === "string",
      )
    : [];
  const contract = { pluginId: manifestPluginId, webSearchProviderIds };
  bundledWebSearchManifestContracts.set(pluginId, contract);
  return contract;
}

function resolveBundledManifestWebSearchOwnerPluginId(params: {
  pluginId: string;
  providerId: string;
}): string | undefined {
  const normalizedProviderId = normalizeOptionalLowercaseString(params.providerId);
  if (!normalizedProviderId) {
    return undefined;
  }

  const contract = readBundledWebSearchManifestContract(params.pluginId);
  if (
    !contract?.webSearchProviderIds.some(
      (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId,
    )
  ) {
    return undefined;
  }
  return contract.pluginId || undefined;
}

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
      const providers =
        resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
          onlyPluginIds: [pluginId],
        }) ?? [];
      expect(providers.length).toBeGreaterThan(0);
      for (const provider of providers) {
        expect(
          resolveBundledManifestWebSearchOwnerPluginId({
            pluginId,
            providerId: provider.id,
          }),
        ).toBe(pluginId);
      }
    });

    it("keeps fast-path provider metadata aligned with the bundled runtime artifact", async () => {
      const fastPathProviders =
        resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
          onlyPluginIds: [pluginId],
        })?.filter((provider) => provider.pluginId === pluginId) ?? [];
      const bundledProviderEntries =
        resolveBundledExplicitRuntimeWebSearchProvidersFromPublicArtifacts({
          onlyPluginIds: [pluginId],
        })?.filter((entry) => entry.pluginId === pluginId) ?? [];

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
