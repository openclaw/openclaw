import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../../plugins/manifest-owner-policy.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveManifestDeclaredProviderAuthChoices,
  resolveManifestProviderAuthChoices,
} from "../../plugins/provider-auth-choices.js";
import {
  listProviderLoginOptions,
  listProviderSetupOptions,
} from "../../plugins/provider-login-options.js";
import {
  supportsSetupManualSecret,
  supportsSetupTextInference,
} from "../../system-agent/setup-inference-auth-options.js";
import type { ModelProviderCapability } from "./models-auth-status.types.js";

export function resolveModelProviderCapabilities(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir: string;
}): {
  capabilities: ModelProviderCapability[];
  resolveProvider: (provider: string) => string;
} {
  const lookup = {
    ...params,
    env: params.env ?? process.env,
    includeUntrustedWorkspacePlugins: false,
  };
  const resolveProvider = (provider: string) => resolveProviderIdForAuth(provider, lookup);
  const { providers, modelCatalogProviders } = params.metadataSnapshot.owners;
  const modelProviders = new Set(
    [...providers.keys(), ...modelCatalogProviders.keys()].map(resolveProvider),
  );
  const capabilities = new Map<string, ModelProviderCapability>();
  const loginChoices = resolveManifestDeclaredProviderAuthChoices({
    ...lookup,
    includeWorkspacePlugins: false,
  });
  const loginOptions = listProviderLoginOptions(loginChoices);
  const choices = resolveManifestProviderAuthChoices(lookup);
  const normalizedConfig = normalizePluginsConfig(params.config.plugins);
  const setupOwners = new Set(
    params.metadataSnapshot.plugins
      .filter(
        (plugin) =>
          plugin.origin !== "workspace" &&
          passesManifestOwnerBasePolicy({ plugin, normalizedConfig }),
      )
      .map((plugin) => plugin.id),
  );
  const setupOptions = listProviderSetupOptions(
    choices.filter((choice) => setupOwners.has(choice.pluginId)),
  );
  for (const choice of choices) {
    const provider = resolveProvider(choice.providerId);
    // Setup descriptors also include tools and media-only services, not just model accounts.
    if (!modelProviders.has(provider) || !supportsSetupTextInference(choice.onboardingScopes)) {
      continue;
    }
    const current = capabilities.get(provider);
    const apiKeySupported = choice.methodId === "api-key";
    const quickApiKeySetup = apiKeySupported && supportsSetupManualSecret(choice);
    const providerLoginOptions = loginOptions.filter(
      (option) => resolveProvider(option.brandId) === provider,
    );
    const providerSetupOptions = setupOptions.filter(
      (option) => resolveProvider(option.brandId) === provider,
    );
    capabilities.set(provider, {
      provider,
      apiKeySupported: current?.apiKeySupported === true || apiKeySupported,
      quickApiKeySetup: current?.quickApiKeySetup === true || quickApiKeySetup,
      ...(providerLoginOptions.length > 0 ? { loginOptions: providerLoginOptions } : {}),
      ...(providerSetupOptions.length > 0 ? { setupOptions: providerSetupOptions } : {}),
    });
  }
  return {
    capabilities: [...capabilities.values()].toSorted((a, b) =>
      a.provider.localeCompare(b.provider),
    ),
    resolveProvider,
  };
}
