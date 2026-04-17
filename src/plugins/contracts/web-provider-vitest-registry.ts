import { createGeminiWebSearchProvider } from "../../../extensions/google/web-search-contract-api.js";
import type { WebSearchProviderPlugin } from "../types.js";

export type WebSearchProviderContractEntry = {
  pluginId: string;
  provider: WebSearchProviderPlugin;
  credentialValue: unknown;
};

let webSearchProviderContractRegistryCache: WebSearchProviderContractEntry[] | null = null;

export function loadVitestWebSearchProviderContractRegistry(): WebSearchProviderContractEntry[] {
  webSearchProviderContractRegistryCache ??= [
    {
      pluginId: "google",
      provider: createGeminiWebSearchProvider(),
      credentialValue: "AIzaSyDUMMY",
    },
  ];
  return webSearchProviderContractRegistryCache;
}
