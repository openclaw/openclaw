import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingProvider } from "./provider-types.js";

/** Keeps authored provider IDs so callers can project canonical or execution aliases. */
export function listImageCapableConfiguredProviders(cfg?: OpenClawConfig): string[] {
  return Object.entries(cfg?.models?.providers ?? {})
    .filter(
      ([id, provider]) =>
        // Config-write secrets preflight reads source config before model defaults.
        id.trim() && (provider.models ?? []).some((model) => model.input?.includes("image")),
    )
    .map(([id]) => id);
}

/** Project static registrations against the caller's config without changing cached providers. */
export function resolveConfiguredMediaProviderCapabilities(
  provider: MediaUnderstandingProvider,
  cfg?: OpenClawConfig,
  registeredProviders?: { has(id: string): boolean },
) {
  if (
    provider.inheritConfiguredImageCapability &&
    !provider.capabilities?.includes("image") &&
    listImageCapableConfiguredProviders(cfg).some(
      (id) =>
        normalizeMediaProviderId(id, registeredProviders) ===
        normalizeMediaProviderId(provider.id, registeredProviders),
    )
  ) {
    return [...(provider.capabilities ?? []), "image" as const];
  }
  return provider.capabilities;
}
