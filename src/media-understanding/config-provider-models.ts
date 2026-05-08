import type { OpenClawConfig } from "../config/types.js";
import { normalizeMediaProviderId } from "./provider-id.js";

type ConfigProvider = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
>;

type ConfigProviderModel = NonNullable<ConfigProvider["models"]>[number];

function hasCapableModel(
  providerCfg: ConfigProvider,
  capability: "image" | "audio" | "video",
): boolean {
  const models = providerCfg.models ?? [];
  return models.some(
    (model: ConfigProviderModel) => Array.isArray(model?.input) && model.input.includes(capability),
  );
}

export function resolveImageCapableConfigProviderIds(cfg?: OpenClawConfig): string[] {
  return resolveCapableConfigProviderIds(cfg, "image");
}

export function resolveAudioCapableConfigProviderIds(cfg?: OpenClawConfig): string[] {
  return resolveCapableConfigProviderIds(cfg, "audio");
}

export function resolveVideoCapableConfigProviderIds(cfg?: OpenClawConfig): string[] {
  return resolveCapableConfigProviderIds(cfg, "video");
}

function resolveCapableConfigProviderIds(
  cfg: OpenClawConfig | undefined,
  capability: "image" | "audio" | "video",
): string[] {
  const configProviders = cfg?.models?.providers;
  if (!configProviders || typeof configProviders !== "object") {
    return [];
  }

  const providerIds: string[] = [];
  for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
    if (!providerKey?.trim() || !hasCapableModel(providerCfg, capability)) {
      continue;
    }
    providerIds.push(normalizeMediaProviderId(providerKey));
  }
  return providerIds;
}
