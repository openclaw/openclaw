import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import type {
  RemoteModelCatalogPrice,
  RemoteModelCatalogUpstreamPrice,
  RemoteModelCatalogWireBundle,
} from "./remote-bundle.js";

/** A validated download retained only through its immediate activation. */
export type ValidatedRemoteModelCatalog = {
  readonly sourceUrl: string;
  readonly bundleJson: string;
  readonly bundle: RemoteModelCatalogWireBundle;
};

export type ActiveRemoteModelCatalog = {
  sourceUrl: string;
  generatedAt: number;
  revision: string;
  providers: Readonly<Record<string, ModelCatalogProvider>>;
  recommendations: Readonly<Record<string, readonly string[]>>;
  pricing: Readonly<Record<string, RemoteModelCatalogPrice>>;
  upstreamPricing: Readonly<Record<string, RemoteModelCatalogUpstreamPrice>>;
};
