import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type ConfiguredModelProvider = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];
const OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID = "openai-compatible";
const OPENAI_COMPATIBLE_MODEL_APIS = new Set(["openai-completions", "openai-responses"]);

function resolveConfiguredProviderConfig(
  providerId: string,
  cfg?: OpenClawConfig,
): ConfiguredModelProvider | undefined {
  const providers = cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const normalized = normalizeProviderId(providerId);
  return (
    providers[providerId] ??
    Object.entries(providers).find(
      ([candidateId]) => normalizeProviderId(candidateId) === normalized,
    )?.[1]
  );
}

/** Reads a configured provider's backing API id when runtime lookup should follow an alias. */
export function resolveConfiguredGenericEmbeddingProviderId(
  providerId: string,
  cfg?: OpenClawConfig,
): string | undefined {
  const providerConfig = resolveConfiguredProviderConfig(providerId, cfg);
  if (!providerConfig) {
    return undefined;
  }
  const api = providerConfig.api?.trim();
  const normalizedApi = api ? normalizeProviderId(api) : undefined;
  const resolvedProviderId = normalizedApi
    ? OPENAI_COMPATIBLE_MODEL_APIS.has(normalizedApi)
      ? OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID
      : normalizedApi
    : providerConfig.baseUrl?.trim()
      ? OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID
      : undefined;
  return resolvedProviderId && resolvedProviderId !== normalizeProviderId(providerId)
    ? resolvedProviderId
    : undefined;
}
