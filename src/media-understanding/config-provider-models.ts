// Config provider model helpers discover image-capable custom providers for
// media-understanding auto-registration.
import type { OpenClawConfig } from "../config/types.js";
import { configuredModelInputSupportsImage } from "./known-model-capabilities.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";

type ConfigProvider = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
>;

type ConfigProviderModel = NonNullable<ConfigProvider["models"]>[number];

function hasImageCapableModel(params: {
  providerId: string;
  providerCfg: ConfigProvider;
  providerRegistry?: Map<string, Pick<MediaUnderstandingProvider, "modelCapabilityOverrides">>;
}): boolean {
  const models = params.providerCfg.models ?? [];
  return models.some((model: ConfigProviderModel) => {
    const modelId = model?.id?.trim();
    return Boolean(
      modelId &&
      configuredModelInputSupportsImage({
        modelId,
        input: model?.input,
        provider: params.providerRegistry?.get(normalizeMediaProviderId(params.providerId)),
      }),
    );
  });
}

/** Finds configured model providers that can be auto-registered for image understanding. */
export function resolveImageCapableConfigProviderIds(
  cfg?: OpenClawConfig,
  providerRegistry?: Map<string, Pick<MediaUnderstandingProvider, "modelCapabilityOverrides">>,
): string[] {
  const configProviders = cfg?.models?.providers;
  if (!configProviders || typeof configProviders !== "object") {
    return [];
  }

  const providerIds: string[] = [];
  for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
    if (
      !providerKey?.trim() ||
      !hasImageCapableModel({ providerId: providerKey, providerCfg, providerRegistry })
    ) {
      continue;
    }
    providerIds.push(normalizeMediaProviderId(providerKey));
  }
  return providerIds;
}
