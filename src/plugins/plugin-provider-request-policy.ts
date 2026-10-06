import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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
    ...(openAICompletions ? { openAICompletions } : {}),
  } satisfies PluginManifestProviderRequestProvider;
  return Object.keys(providerRequest).length > 0 ? providerRequest : undefined;
}
