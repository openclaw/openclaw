import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import type { RemoteModelCatalogPrice, RemoteModelCatalogUpstreamPrice } from "./remote-bundle.js";

export type ActiveRemoteModelCatalog = {
  sourceUrl: string;
  generatedAt: number;
  revision: string;
  providers: Readonly<Record<string, ModelCatalogProvider>>;
  recommendations: Readonly<Record<string, readonly string[]>>;
  pricing: Readonly<Record<string, RemoteModelCatalogPrice>>;
  upstreamPricing: Readonly<Record<string, RemoteModelCatalogUpstreamPrice>>;
};
