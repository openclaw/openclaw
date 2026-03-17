import type { ModelProviderConfig } from "../config/types.js";
import type { ProviderCatalogContext, ProviderCatalogResult } from "./types.js";

export async function buildSingleProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
  allowExplicitBaseUrl?: boolean;
}): Promise<ProviderCatalogResult> {
  const apiKey = params.ctx.resolveProviderApiKey(params.providerId).apiKey;
  if (!apiKey) {
    return null;
  }

  const explicitProvider = params.allowExplicitBaseUrl
    ? params.ctx.config.models?.providers?.[params.providerId]
    : undefined;
  const explicitBaseUrl =
    typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "";

  return {
    provider: {
      ...(await params.buildProvider()),
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
      apiKey,
    },
  };
}
