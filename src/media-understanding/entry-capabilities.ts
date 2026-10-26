import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingCapabilityRegistry,
} from "./types.js";

const MEDIA_CAPABILITIES = ["audio", "image", "video"] as const;

function isMediaCapability(value: unknown): value is MediaUnderstandingCapability {
  return typeof value === "string" && (MEDIA_CAPABILITIES as readonly string[]).includes(value);
}

export function resolveConfiguredMediaEntryCapabilities(
  entry: MediaUnderstandingModelConfig,
): MediaUnderstandingCapability[] | undefined {
  if (!Array.isArray(entry.capabilities)) {
    return undefined;
  }
  const capabilities = entry.capabilities.filter(isMediaCapability);
  return capabilities.length > 0 ? capabilities : undefined;
}

/** Resolves the capability set for an entry, inferring shared provider entries from metadata. */
export function resolveEffectiveMediaEntryCapabilities(params: {
  entry: MediaUnderstandingModelConfig;
  providerRegistry: MediaUnderstandingCapabilityRegistry;
}): MediaUnderstandingCapability[] | undefined {
  const configured = resolveConfiguredMediaEntryCapabilities(params.entry);
  if (configured) {
    return configured;
  }
  if ((params.entry.type ?? (params.entry.command ? "cli" : "provider")) === "cli") {
    return undefined;
  }
  const providerId = normalizeMediaProviderId(params.entry.provider ?? "");
  if (!providerId) {
    return undefined;
  }
  const provider = params.providerRegistry.get(providerId);
  return provider?.sharedEntryCapabilities === undefined
    ? provider?.capabilities
    : provider.sharedEntryCapabilities.filter((capability) =>
        provider.capabilities?.includes(capability),
      );
}

export function matchesImageEntryCapability(params: {
  entry: MediaUnderstandingModelConfig;
  providerRegistry: MediaUnderstandingCapabilityRegistry;
}): boolean {
  const capabilities = resolveEffectiveMediaEntryCapabilities(params);
  return capabilities?.includes("image") ?? false;
}
