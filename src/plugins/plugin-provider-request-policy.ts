import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { PluginManifestProviderRequestProvider } from "./manifest-types.js";

/** Manifest parsing and prepared metadata use the same provider request policy. */
export function normalizeManifestProviderRequestProvider(
  value: unknown,
): PluginManifestProviderRequestProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const family = normalizeOptionalString(value.family);
  const compatibilityFamily =
    normalizeOptionalString(value.compatibilityFamily) === "moonshot" ? "moonshot" : undefined;
  const supportsStreamingUsage = isRecord(value.openAICompletions)
    ? value.openAICompletions.supportsStreamingUsage
    : undefined;
  const openAICompletions =
    typeof supportsStreamingUsage === "boolean" ? { supportsStreamingUsage } : undefined;
  const providerRequest = {
    ...(family ? { family } : {}),
    ...(compatibilityFamily ? { compatibilityFamily } : {}),
    ...(isRecord(value.modelParamsSchema) ? { modelParamsSchema: value.modelParamsSchema } : {}),
    ...(openAICompletions ? { openAICompletions } : {}),
  } satisfies PluginManifestProviderRequestProvider;
  return Object.keys(providerRequest).length > 0 ? providerRequest : undefined;
}

/** Preserve request metadata's last-declaration ownership for validation and presentation. */
export function collectPluginProviderRequestOwners(plugins: readonly PluginManifestRecord[]) {
  const owners = new Map<
    string,
    { plugin: PluginManifestRecord; policy: PluginManifestProviderRequestProvider }
  >();
  for (const plugin of plugins) {
    const requests = isRecord(plugin.providerRequest?.providers)
      ? plugin.providerRequest.providers
      : {};
    for (const [rawProvider, request] of Object.entries(requests)) {
      const provider = normalizeLowercaseStringOrEmpty(rawProvider);
      if (provider && isRecord(request)) {
        owners.set(provider, {
          plugin,
          policy: normalizeManifestProviderRequestProvider(request) ?? {},
        });
      }
    }
  }
  return owners;
}
