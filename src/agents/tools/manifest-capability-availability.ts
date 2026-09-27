/**
 * Manifest capability availability checks.
 *
 * Combines plugin contracts, availability, config signals, auth profiles, env candidates, and base URL guards.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createInstalledPluginEnabledPredicate } from "../../plugins/installed-plugin-index.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import {
  hasNonEmptyManifestEnvCandidate,
  manifestConfigSignalPasses,
  manifestPluginSetupProviderEnvVars,
  manifestProviderBaseUrlGuardPasses,
} from "../../plugins/manifest-tool-availability.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../../plugins/runtime-state.js";
import { listProfilesForProvider } from "../auth-profiles/profile-list.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isAuthModeAllowedForModel } from "../model-auth-policy.js";
import {
  profileTypeToAuthMode,
  resolveProviderEntryApiKeyProfileReference,
} from "../model-auth-provider-config.js";

/** Manifest contract keys that represent provider-backed tool capabilities. */
type CapabilityContractKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "mediaUnderstandingProviders";

type CapabilityProviderMetadataKey =
  | "imageGenerationProviderMetadata"
  | "videoGenerationProviderMetadata"
  | "musicGenerationProviderMetadata";

type CapabilityMetadataSnapshot = Pick<PluginMetadataSnapshot, "index" | "plugins">;

const GENERATION_AUTH_CAPABILITIES = {
  imageGenerationProviders: "image-generation",
  videoGenerationProviders: "video-generation",
  musicGenerationProviders: "music-generation",
} as const;

export function capabilityAuthOperation(key: CapabilityContractKey): string | undefined {
  // Media understanding has separate image-input and transcription operations.
  return key === "mediaUnderstandingProviders" ? undefined : GENERATION_AUTH_CAPABILITIES[key];
}

function metadataKeyForCapabilityContract(
  key: CapabilityContractKey,
): CapabilityProviderMetadataKey | undefined {
  switch (key) {
    case "imageGenerationProviders":
      return "imageGenerationProviderMetadata";
    case "videoGenerationProviders":
      return "videoGenerationProviderMetadata";
    case "musicGenerationProviders":
      return "musicGenerationProviderMetadata";
    case "mediaUnderstandingProviders":
      return undefined;
  }
  return undefined;
}

function listCapabilityAuthSignals(params: {
  plugin: PluginManifestRecord;
  key: CapabilityContractKey;
  providerId: string;
}): Array<{
  provider: string;
  providerBaseUrl?: NonNullable<
    NonNullable<PluginManifestRecord["imageGenerationProviderMetadata"]>[string]["authSignals"]
  >[number]["providerBaseUrl"];
}> {
  const metadataKey = metadataKeyForCapabilityContract(params.key);
  const metadata = metadataKey ? params.plugin[metadataKey]?.[params.providerId] : undefined;
  if (metadata?.authSignals?.length) {
    return metadata.authSignals;
  }
  // Older manifests only declare provider ids; derive auth signals from aliases/providers.
  return [params.providerId, ...(metadata?.aliases ?? []), ...(metadata?.authProviders ?? [])].map(
    (provider) => ({ provider }),
  );
}

function hasAvailableCapabilityPlugin(
  params: {
    snapshot: CapabilityMetadataSnapshot;
    config?: OpenClawConfig;
  },
  accepts: (plugin: PluginManifestRecord) => boolean,
): boolean {
  if (params.config?.plugins?.enabled === false) {
    return false;
  }
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  const isInstalledPluginEnabled = createInstalledPluginEnabledPredicate(
    params.snapshot.index.plugins,
    params.config,
  );
  return params.snapshot.plugins.some(
    (plugin) =>
      isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
        normalizedConfig,
        isInstalledPluginEnabled,
      }) && accepts(plugin),
  );
}

function hasConfiguredCapabilityProviderSignal(params: {
  plugin: PluginManifestRecord;
  key: CapabilityContractKey;
  providerId: string;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  const metadataKey = metadataKeyForCapabilityContract(params.key);
  const metadata = metadataKey ? params.plugin[metadataKey]?.[params.providerId] : undefined;
  if (
    metadata?.configSignals?.some((signal) =>
      manifestConfigSignalPasses({
        config: params.config,
        env: process.env,
        signal,
      }),
    )
  ) {
    return true;
  }
  for (const signal of listCapabilityAuthSignals({
    plugin: params.plugin,
    key: params.key,
    providerId: params.providerId,
  })) {
    if (
      !manifestProviderBaseUrlGuardPasses({
        config: params.config,
        guard: signal.providerBaseUrl,
      })
    ) {
      continue;
    }
    const capability = capabilityAuthOperation(params.key);
    const binding =
      capability && params.authStore
        ? resolveProviderEntryApiKeyProfileReference({
            cfg: params.config,
            provider: signal.provider,
            store: params.authStore,
          })
        : undefined;
    // Explicit bindings own execution; another account cannot make a rejected
    // selection available just because it supports the same capability.
    if (binding?.kind === "profile-incompatible") {
      continue;
    }
    const profileIds =
      binding?.kind === "profile"
        ? [binding.profileId]
        : params.authStore
          ? listProfilesForProvider(params.authStore, signal.provider)
          : [];
    if (
      profileIds.some((profileId) => {
        const credential = params.authStore?.profiles[profileId];
        return (
          credential &&
          (!capability ||
            isAuthModeAllowedForModel({
              provider: signal.provider,
              capability,
              mode: profileTypeToAuthMode(credential.type),
              authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
            }))
        );
      })
    ) {
      return true;
    }
    if (binding?.kind === "profile") {
      continue;
    }
    if (
      hasNonEmptyManifestEnvCandidate(
        process.env,
        manifestPluginSetupProviderEnvVars(params.plugin, signal.provider),
      ) &&
      (!capability ||
        isAuthModeAllowedForModel({ provider: signal.provider, capability, mode: "api-key" }))
    ) {
      return true;
    }
  }
  return false;
}

/** Returns the active capability metadata snapshot when one is already loaded. */
export function getCurrentCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): PluginMetadataSnapshot | undefined {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  return getCurrentPluginMetadataSnapshot({
    config: params.config,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

/** Loads capability metadata from current config/workspace plugin state. */
export function loadCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Pick<PluginMetadataSnapshot, "index" | "plugins"> {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  return resolvePluginMetadataSnapshot({
    config: params.config ?? {},
    env: params.env ?? process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

/** Checks whether any available plugin has a configured provider for a capability contract. */
export function hasSnapshotCapabilityAvailability(params: {
  snapshot: CapabilityMetadataSnapshot;
  key: CapabilityContractKey;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  return hasAvailableCapabilityPlugin(params, (plugin) =>
    (plugin.contracts?.[params.key] ?? []).some((providerId) =>
      hasConfiguredCapabilityProviderSignal({
        plugin,
        key: params.key,
        providerId,
        config: params.config,
        authStore: params.authStore,
      }),
    ),
  );
}

/** Checks whether any available plugin exposes env-backed auth for a provider id. */
export function hasSnapshotProviderEnvAvailability(params: {
  snapshot: CapabilityMetadataSnapshot;
  providerId: string;
  config?: OpenClawConfig;
}): boolean {
  return hasAvailableCapabilityPlugin(params, (plugin) =>
    hasNonEmptyManifestEnvCandidate(
      process.env,
      manifestPluginSetupProviderEnvVars(plugin, params.providerId),
    ),
  );
}

/** Checks whether a specific provider id is available for a capability contract. */
export function hasSnapshotCapabilityProviderAvailability(params: {
  snapshot: CapabilityMetadataSnapshot;
  key: CapabilityContractKey;
  providerId: string;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  return hasAvailableCapabilityPlugin(params, (plugin) => {
    if (!plugin.contracts?.[params.key]?.includes(params.providerId)) {
      return false;
    }
    return hasConfiguredCapabilityProviderSignal({
      plugin,
      key: params.key,
      providerId: params.providerId,
      config: params.config,
      authStore: params.authStore,
    });
  });
}
