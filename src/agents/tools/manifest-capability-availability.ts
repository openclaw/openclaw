import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { listProfilesForProvider } from "../auth-profiles.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";

export type CapabilityContractKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "mediaUnderstandingProviders";

type CapabilityProviderMetadataKey =
  | "imageGenerationProviderMetadata"
  | "videoGenerationProviderMetadata"
  | "musicGenerationProviderMetadata";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readPath(root: unknown, path: string | undefined): unknown {
  if (!path?.trim()) {
    return root;
  }
  let current = root;
  for (const segment of path.split(".")) {
    const key = segment.trim();
    if (!key) {
      return undefined;
    }
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function readStringAtPath(root: unknown, path: string): string | undefined {
  const value = readPath(root, path);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readEffectiveConfig(params: {
  config?: OpenClawConfig;
  rootPath: string;
  overlayPath?: string;
}): Record<string, unknown> | undefined {
  const root = readPath(params.config, params.rootPath);
  if (!isRecord(root)) {
    return undefined;
  }
  const overlay = readPath(root, params.overlayPath);
  return isRecord(overlay) ? { ...root, ...overlay } : root;
}

function hasConfiguredValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return value !== undefined && value !== null;
}

function configSignalPasses(params: {
  config?: OpenClawConfig;
  signal: NonNullable<
    NonNullable<PluginManifestRecord["imageGenerationProviderMetadata"]>[string]["configSignals"]
  >[number];
}): boolean {
  const effectiveConfig = readEffectiveConfig({
    config: params.config,
    rootPath: params.signal.rootPath,
    overlayPath: params.signal.overlayPath,
  });
  if (!effectiveConfig) {
    return false;
  }
  const modeSignal = params.signal.mode;
  if (modeSignal) {
    const modePath = modeSignal.path?.trim() || "mode";
    const mode = readStringAtPath(effectiveConfig, modePath) ?? modeSignal.default;
    if (!mode) {
      return false;
    }
    if (modeSignal.allowed?.length && !modeSignal.allowed.includes(mode)) {
      return false;
    }
    if (modeSignal.disallowed?.includes(mode)) {
      return false;
    }
  }
  for (const requiredPath of params.signal.required ?? []) {
    if (!hasConfiguredValue(readPath(effectiveConfig, requiredPath))) {
      return false;
    }
  }
  const requiredAny = params.signal.requiredAny ?? [];
  if (
    requiredAny.length > 0 &&
    !requiredAny.some((path) => hasConfiguredValue(readPath(effectiveConfig, path)))
  ) {
    return false;
  }
  return true;
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
}

function normalizeBaseUrlForManifestGuard(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function providerBaseUrlGuardPasses(params: {
  config?: OpenClawConfig;
  guard: NonNullable<
    NonNullable<PluginManifestRecord["imageGenerationProviderMetadata"]>[string]["authSignals"]
  >[number]["providerBaseUrl"];
}): boolean {
  const guard = params.guard;
  if (!guard) {
    return true;
  }
  const providerConfig = params.config?.models?.providers?.[guard.provider];
  const rawBaseUrl =
    typeof providerConfig?.baseUrl === "string" && providerConfig.baseUrl.trim()
      ? providerConfig.baseUrl
      : guard.defaultBaseUrl;
  if (!rawBaseUrl) {
    return false;
  }
  const normalizedBaseUrl = normalizeBaseUrlForManifestGuard(rawBaseUrl);
  return guard.allowedBaseUrls.some(
    (allowedBaseUrl) => normalizeBaseUrlForManifestGuard(allowedBaseUrl) === normalizedBaseUrl,
  );
}

function pluginSetupProviderEnvVars(
  plugin: PluginManifestRecord,
  providerId: string,
): readonly string[] {
  const direct = plugin.setup?.providers?.find((provider) => provider.id === providerId)?.envVars;
  if (direct && direct.length > 0) {
    return direct;
  }
  return plugin.providerAuthEnvVars?.[providerId] ?? [];
}

function hasNonEmptyEnvCandidate(envVars: readonly string[]): boolean {
  return envVars.some((envVar) => {
    const key = envVar.trim();
    return key.length > 0 && Boolean(process.env[key]?.trim());
  });
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
  return [params.providerId, ...(metadata?.aliases ?? []), ...(metadata?.authProviders ?? [])].map(
    (provider) => ({ provider }),
  );
}

export function getCurrentCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): PluginMetadataSnapshot | undefined {
  return getCurrentPluginMetadataSnapshot({
    config: params.config,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

export function hasSnapshotCapabilityAvailability(params: {
  snapshot: PluginMetadataSnapshot;
  key: CapabilityContractKey;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  for (const plugin of params.snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    const metadataKey = metadataKeyForCapabilityContract(params.key);
    for (const providerId of plugin.contracts?.[params.key] ?? []) {
      const metadata = metadataKey ? plugin[metadataKey]?.[providerId] : undefined;
      if (
        metadata?.configSignals?.some((signal) =>
          configSignalPasses({
            config: params.config,
            signal,
          }),
        )
      ) {
        return true;
      }
      for (const signal of listCapabilityAuthSignals({
        plugin,
        key: params.key,
        providerId,
      })) {
        if (
          !providerBaseUrlGuardPasses({
            config: params.config,
            guard: signal.providerBaseUrl,
          })
        ) {
          continue;
        }
        if (
          params.authStore &&
          listProfilesForProvider(params.authStore, signal.provider).length > 0
        ) {
          return true;
        }
        if (hasNonEmptyEnvCandidate(pluginSetupProviderEnvVars(plugin, signal.provider))) {
          return true;
        }
      }
    }
  }
  return false;
}

export function hasSnapshotProviderEnvAvailability(params: {
  snapshot: PluginMetadataSnapshot;
  providerId: string;
  config?: OpenClawConfig;
}): boolean {
  for (const plugin of params.snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    if (hasNonEmptyEnvCandidate(pluginSetupProviderEnvVars(plugin, params.providerId))) {
      return true;
    }
  }
  return false;
}
