import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";
import { describeImageWithModel, describeImagesWithModel } from "./image.js";

function mergeProviderIntoRegistry(
  registry: Map<string, MediaUnderstandingProvider>,
  provider: MediaUnderstandingProvider,
) {
  const normalizedKey = normalizeMediaProviderId(provider.id);
  const existing = registry.get(normalizedKey);
  const merged = existing
    ? {
        ...existing,
        ...provider,
        capabilities: provider.capabilities ?? existing.capabilities,
      }
    : provider;
  registry.set(normalizedKey, merged);
}

export { normalizeMediaProviderId } from "./provider-id.js";

export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of resolvePluginCapabilityProviders({
    key: "mediaUnderstandingProviders",
    cfg,
  })) {
    mergeProviderIntoRegistry(registry, provider);
  }
  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const normalizedKey = normalizeMediaProviderId(key);
      const existing = registry.get(normalizedKey);
      const merged = existing
        ? {
            ...existing,
            ...provider,
            capabilities: provider.capabilities ?? existing.capabilities,
          }
        : provider;
      registry.set(normalizedKey, merged);
    }
  }
  // Auto-register custom providers that use a known API format (e.g.
  // "anthropic-messages") and declare image input support.  This allows
  // third-party or self-hosted providers to be used by the `image` tool
  // without requiring a dedicated media-understanding plugin.
  const configuredProviders = cfg?.models?.providers;
  if (configuredProviders && typeof configuredProviders === "object") {
    for (const [providerId, providerConfig] of Object.entries(configuredProviders)) {
      const normalizedKey = normalizeMediaProviderId(providerId);
      if (registry.has(normalizedKey)) {
        continue;
      }
      const api = (providerConfig as Record<string, unknown> | undefined)?.api;
      if (api === "anthropic-messages" || api === "openai-responses" || api === "openai-completions") {
        const models = Array.isArray(
          (providerConfig as Record<string, unknown> | undefined)?.models,
        )
          ? ((providerConfig as Record<string, unknown>).models as Array<Record<string, unknown>>)
          : [];
        const hasImageModel = models.some(
          (m) => Array.isArray(m?.input) && (m.input as string[]).includes("image"),
        );
        if (hasImageModel) {
          registry.set(normalizedKey, {
            id: providerId,
            capabilities: ["image"],
            describeImage: describeImageWithModel,
            describeImages: describeImagesWithModel,
          });
        }
      }
    }
  }
  return registry;
}

export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
