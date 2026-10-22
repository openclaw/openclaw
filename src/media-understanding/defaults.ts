import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  normalizeMediaExecutionProviderId,
  normalizeMediaProviderId,
} from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { listImageCapableConfiguredProviders } from "./config-provider-models.js";
import {
  resolveAutoMediaKeyProvidersFromRegistry,
  resolveDefaultMediaModelFromRegistry,
} from "./provider-registry-metadata.js";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";
export { CLI_OUTPUT_MAX_BUFFER } from "./defaults.constants.js";

// Defaults follow the selected immutable manifest generation, including retained
// owners. Configured model overrides remain outside this projection.
const registriesByManifest = new WeakMap<
  PluginManifestRegistry,
  Map<string, MediaUnderstandingProvider>
>();

/** Builds a media provider registry from trusted manifest metadata without loading plugin code. */
function buildMediaUnderstandingManifestMetadataRegistry(
  cfg?: OpenClawConfig,
  workspaceDir?: string,
): Map<string, MediaUnderstandingProvider> {
  const snapshot = loadManifestMetadataSnapshot({
    config: cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  const cached = registriesByManifest.get(snapshot.manifestRegistry);
  if (cached) {
    return cached;
  }
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const plugin of snapshot.plugins) {
    // Metadata only counts when the manifest also declares the provider contract.
    const declaredProviders = new Set(
      (plugin.contracts?.mediaUnderstandingProviders ?? []).map((providerId) =>
        normalizeMediaProviderId(providerId),
      ),
    );
    for (const [providerId, metadata] of Object.entries(
      plugin.mediaUnderstandingProviderMetadata ?? {},
    )) {
      // Metadata is trusted only when the plugin also declares the corresponding
      // provider contract; stray manifest fields must not register providers.
      const normalizedProviderId = normalizeMediaProviderId(providerId);
      if (!normalizedProviderId || !declaredProviders.has(normalizedProviderId)) {
        continue;
      }
      registry.set(normalizedProviderId, {
        id: normalizedProviderId,
        capabilities: metadata.capabilities,
        defaultModels: metadata.defaultModels,
        autoPriority: metadata.autoPriority,
        nativeDocumentInputs: metadata.nativeDocumentInputs,
        documentModels: metadata.documentModels,
      });
    }
  }
  registriesByManifest.set(snapshot.manifestRegistry, registry);
  return registry;
}

function resolveConfiguredImageProviderModel(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): string | undefined {
  const normalizedProviderId = normalizeMediaProviderId(params.providerId);
  for (const [providerKey, providerCfg] of Object.entries(params.cfg?.models?.providers ?? {})) {
    if (normalizeMediaProviderId(providerKey) !== normalizedProviderId) {
      continue;
    }
    const match = (providerCfg.models ?? []).find(
      (model) => Boolean(normalizeOptionalString(model.id)) && model.input?.includes("image"),
    );
    return normalizeOptionalString(match?.id);
  }
  return undefined;
}

function resolveConfiguredImageProviderIds(cfg?: OpenClawConfig): string[] {
  return uniqueStrings(
    listImageCapableConfiguredProviders(cfg).map(normalizeMediaExecutionProviderId),
  );
}

function isExecutionAliasProvider(providerId: string): boolean {
  return normalizeMediaProviderId(providerId) !== providerId;
}

/** Resolves the default provider model for a media capability from config or manifest metadata. */
export function resolveDefaultMediaModel(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
  includeConfiguredImageModels?: boolean;
}): string | undefined {
  if (!params.providerRegistry && params.includeConfiguredImageModels !== false) {
    const configuredImageModel =
      params.capability === "image"
        ? resolveConfiguredImageProviderModel({
            cfg: params.cfg,
            providerId: params.providerId,
          })
        : undefined;
    if (configuredImageModel) {
      return configuredImageModel;
    }
  }
  const registry =
    params.providerRegistry ??
    buildMediaUnderstandingManifestMetadataRegistry(params.cfg, params.workspaceDir);
  return resolveDefaultMediaModelFromRegistry({
    providerId: params.providerId,
    capability: params.capability,
    providerRegistry: registry,
  });
}

/** Resolves auto-discovery provider order for a media capability using manifest priorities. */
export function resolveAutoMediaKeyProviders(params: {
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string[] {
  const registry =
    params.providerRegistry ??
    buildMediaUnderstandingManifestMetadataRegistry(params.cfg, params.workspaceDir);
  const prioritized = resolveAutoMediaKeyProvidersFromRegistry({
    capability: params.capability,
    providerRegistry: registry,
  });
  if (params.providerRegistry || params.capability !== "image") {
    return prioritized;
  }
  const configured = resolveConfiguredImageProviderIds(params.cfg);
  const merged = [...prioritized];
  for (const providerId of configured.filter(isExecutionAliasProvider)) {
    const canonicalIndex = merged.indexOf(normalizeMediaProviderId(providerId));
    if (canonicalIndex >= 0) {
      merged.splice(canonicalIndex, 0, providerId);
    } else {
      merged.unshift(providerId);
    }
  }
  for (const providerId of configured.filter((id) => !isExecutionAliasProvider(id))) {
    merged.push(providerId);
  }
  return uniqueStrings(merged);
}

/** Returns whether provider metadata declares native PDF document input support. */
export function providerSupportsNativePdfDocument(params: {
  providerId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): boolean {
  const registry =
    params.providerRegistry ??
    buildMediaUnderstandingManifestMetadataRegistry(params.cfg, params.workspaceDir);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  return provider?.nativeDocumentInputs?.includes("pdf") ?? false;
}

/** Resolves provider-specific document model hints, preserving explicit unsupported markers. */
export function resolveDocumentMediaModel(params: {
  providerId: string;
  document: "pdf";
  mode: "textExtraction" | "image";
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string | false | undefined {
  const registry =
    params.providerRegistry ??
    buildMediaUnderstandingManifestMetadataRegistry(params.cfg, params.workspaceDir);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  const value = provider?.documentModels?.[params.document]?.[params.mode];
  if (value === false) {
    return false;
  }
  return normalizeOptionalString(value);
}
