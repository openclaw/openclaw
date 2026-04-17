import { buildAnthropicProvider } from "../../../extensions/anthropic/api.js";
import {
  buildGoogleGeminiCliProvider,
  buildGoogleProvider,
} from "../../../extensions/google/api.js";
import {
  buildOpenAICodexProviderPlugin,
  buildOpenAIProvider,
} from "../../../extensions/openai/api.js";
import type { ProviderPlugin } from "../types.js";

export type ProviderContractEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

let providerContractRegistryCache: ProviderContractEntry[] | null = null;

export function loadVitestProviderContractRegistry(): ProviderContractEntry[] {
  providerContractRegistryCache ??= [
    { pluginId: "anthropic", provider: buildAnthropicProvider() },
    { pluginId: "google", provider: buildGoogleProvider() },
    { pluginId: "google", provider: buildGoogleGeminiCliProvider() },
    { pluginId: "openai", provider: buildOpenAIProvider() },
    { pluginId: "openai", provider: buildOpenAICodexProviderPlugin() },
  ];
  return providerContractRegistryCache;
}
